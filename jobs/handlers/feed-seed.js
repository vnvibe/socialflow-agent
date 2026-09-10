/**
 * feed-seed.js — Chọn bài trên newsfeed và sinh comment.
 *
 * KHÔNG tự bấm DOM để comment. Thay vào đó: phát hiện bài → sinh comment bằng AI
 * → kiểm duyệt → ENQUEUE job `comment_post`. Lý do:
 *   1. comment-post.js đã có luồng comment qua m.facebook.com đã kiểm chứng,
 *      kèm retry và xác minh sau submit. Viết lại là nhân đôi rủi ro.
 *   2. Comment được RẢI RA theo thời gian thay vì dồn trong 1 phiên — đúng thứ
 *      cần cho an toàn (hard-limits đặt 45 phút giữa 2 comment feed).
 *
 * Quảng cáo động: mỗi bài do feed-ad-strategy quyết định — hợp thì cài quảng cáo
 * mềm, không thì comment như user bình thường.
 */

const guard = require('../../lib/checkpoint-guard')
const { recordSignal } = require('../../lib/signal-collector')
const { getPage, releaseSession } = require('../../browser/session-pool')
const { humanMouseMove } = require('../../browser/human')
const { getBlockDetectionScript, reasonToStatus } = require('../../lib/block-detector')
const { checkHardLimit, applyAgeFactor, getNickAgeDays } = require('../../lib/hard-limits')
const feedDom = require('../../browser/feed-dom')
const { buildExclusionContext, screenPost, isVietnamese, isHighAffinity } = require('../../lib/feed-filter')
const { getAffinity } = require('../../lib/user-affinity')
const { decideAdStrategy, buildCommentParams, capForNiche, boostForDeficit, coChoDeNoi } = require('../../lib/feed-ad-strategy')
const aiBrain = require('../../lib/ai-brain')
const { validateCommentNotEcho, looksLikeMetaOutput, looksTruncated, mentionsOwnNick, fabricatesStat, fabricatesDomain, giongMayMoc, saiTenThuongHieu, khuonQuangCaoSao, quangCaoTuBoiXau } = require('../../lib/ai-comment')
const hermes = require('../../lib/hermes-client')
const R = require('../../lib/randomizer')

const FEED_URL = 'https://www.facebook.com/'

async function feedSeed(payload, supabase) {
  const { account_id, max_comments, dry_run = false, job_id } = payload || {}
  if (!account_id) throw new Error('account_id is required for feedSeed')
  // Nhất quán với các handler khác trong dự án (campaign-nurture, campaign-post...)
  const bypassSafety = !!(payload.bypass_safety_limits || payload.force_now || payload.kpi_boost)

  // ── 1. Nick + ngách ──
  const { data: account } = await supabase
    .from('accounts').select('*, proxies(*)').eq('id', account_id).single()
  if (!account) throw new Error('Account not found')

  // PRE-FLIGHT CẦU DAO: nick đã bị ngắt → không farm comment nữa.
  if (['at_risk', 'checkpoint', 'disabled', 'banned'].includes(account.status) || account.is_active === false) {
    throw new Error(`SKIP_nick_paused: ${account.status}`)
  }

  const { data: profiles } = await supabase
    .from('niche_profiles').select('*').eq('account_id', account_id).limit(1)
  const niche = (profiles && profiles[0]) || null
  if (!niche) throw new Error('SKIP_no_niche_profile')
  if (!niche.farming_enabled) throw new Error('SKIP_farming_disabled')

  // Lexicon ngách PER-USER (04/09, SaaS): AI phân tích context ngách của CHÍNH
  // user này (cache 7 ngày trong niche_profiles.ai_affinity) thay cho bộ từ
  // khoá VPS toàn cục — mỗi tenant được soi feed bằng lăng kính ngách riêng.
  const affinity = await getAffinity(niche, supabase)
  console.log(`[FEED-SEED] Lexicon ngách (${affinity.source}): ${affinity.high.size} high / ${affinity.all.length} tổng`)

  // ── 2. Hạn mức ──
  // Warm-up không chặn comment theo tuổi nick nữa (trước đây nick <7 ngày —
  // gồm cả nick lâu năm thiếu fb_created_at — bị SKIP_warmup_week1 và không
  // bao giờ chạy). Nick mới chỉ giảm nhẹ số comment mỗi phiên ở dưới.
  const nickAge = getNickAgeDays(account)

  const budget = account.daily_budget?.feed_comment || { used: 0 }
  const chk = checkHardLimit('feed_comment', budget.used, 0, bypassSafety)
  if (!chk.allowed) throw new Error('SKIP_feed_comment_limit_reached')

  // Quota quảng cáo hôm nay (dùng cho feed-ad-strategy).
  //
  // BUG CŨ 1: lọc `.not('ad_strategy','is',null)` — nhưng file này ghi
  // ad_strategy = strategy HOẶC 'organic' cho MỌI comment, không bao giờ NULL.
  // → đếm cả comment thường (kể cả row skipped) → chạm trần 2 sau 2 lần thử
  // → decideAdStrategy luôn trả 'organic' → quảng cáo KHÔNG BAO GIỜ chạy.
  // BUG CŨ 2: mốc ngày cắt 'YYYY-MM-DD' bị Postgres hiểu là 00:00 UTC = 07:00 VN
  // → cửa sổ đếm lệch 7 tiếng.
  const vnMidnightUtc = (() => {
    const vn = new Date(Date.now() + 7 * 3600 * 1000)
    return new Date(Date.UTC(vn.getUTCFullYear(), vn.getUTCMonth(), vn.getUTCDate()) - 7 * 3600 * 1000).toISOString()
  })()
  const { data: adToday } = await supabase.from('feed_actions')
    .select('id').eq('account_id', account_id).eq('action_type', 'comment')
    .neq('ad_strategy', 'organic')      // chỉ đếm comment CÓ quảng cáo
    .eq('status', 'done')               // và đã đăng thật, không tính lượt hụt
    .gte('created_at', vnMidnightUtc)
  const adCommentsToday = (adToday || []).length
  // Trần quảng cáo/ngày thật sự áp dụng (số cấu hình hoặc auto theo tuổi nick)
  // — dùng cho cơ chế bù nhịp bên dưới, và log cho đúng thay vì `?? 2`.
  const adCap = capForNiche(niche, nickAge)

  // ?? chứ KHÔNG phải || — scheduler gửi max_comments=0 khi user cấu hình nick
  // "chỉ like, không comment". `0 || 2` biến thành 2 → nick vẫn comment đúng
  // lúc user bảo im. Chỉ khi max_comments vắng mặt (job cũ) mới về mặc định 2.
  // Nick mới: giảm nhẹ số comment mỗi phiên thay vì chặn hẳn.
  const requestedComments = max_comments ?? 2

  // Tên miền THẬT của thương hiệu — được phép xuất hiện trong comment quảng cáo,
  // không bị guard bịa-tên-miền chặn. Gom từ cấu hình nick (brand_description +
  // mô tả/từ khoá sản phẩm), hoặc khai báo thẳng niche.brand_domains.
  const brandDomains = (() => {
    if (Array.isArray(niche.brand_domains) && niche.brand_domains.length) return niche.brand_domains
    const nguon = [niche.brand_description, ...(niche.products || []).flatMap(p => [p.description, ...(p.keywords || [])])]
      .filter(Boolean).join(' ')
    return [...new Set(nguon.toLowerCase().match(/\b(?:[a-z0-9][a-z0-9-]*\.)+(?:com|net|org|vn|io|dev|ai|co|xyz|me|app|site|online|shop|info|biz|cloud|tech)\b/g) || [])]
  })()

  // CHỈ TIÊU MỖI PHIÊN — TÔN TRỌNG con số scheduler gửi xuống, KHÔNG tự nhân.
  //
  // feed-scheduler (VPS) đã chia sẵn: commentsPerSession =
  // ceil(daily_comments / seed_per_day), nên max_comments CHÍNH LÀ phần đều của
  // chỉ tiêu ngày (50 ÷ 8 phiên = 7).
  // Bản sửa đầu 27/08 từng lấy max(max_comments, daily_comments/4) vì tôi đọc
  // bản repo local ĐÃ CŨ, tưởng scheduler gửi cứng 5. Giữ lại thì mỗi phiên ăn
  // 13 thay vì 7 → vài phiên sáng đốt sạch ngân sách ngày, các phiên chiều tối
  // đều ném SKIP_no_comment_quota, comment dồn cục đúng kiểu bot.
  // Muốn đổi sản lượng: chỉnh niche_profiles.daily_comments hoặc
  // feed_campaigns.seed_per_day — đừng sửa ở đây.
  const limit = applyAgeFactor(Math.min(requestedComments, chk.remaining), nickAge, bypassSafety)
  if (limit <= 0) throw new Error('SKIP_no_comment_quota')

  let sessionRow = null
  const stats = { scanned: 0, candidates: 0, generated: 0, rejected: 0, queued: 0, ads: 0, ads_attempted: 0, ads_boosted: 0,
    // QUAN TRẮC cơ chế bám camp + AI-ad (24/08): trước đây chỉ có console.log ra
    // stdout nên KHÔNG đo được từ DB — không biết cơ chế đang quyết gì.
    cand_near: 0, cand_far: 0, queued_near: 0, queued_far: 0, far_capped: 0,
    // Đếm lý do LOẠI ở từng cửa. Không có bảng này thì chỉ thấy "46 bài → 3 ứng
    // viên" mà không biết siết ở đâu, nên mọi chỉnh ngưỡng đều là đoán mò.
    filter_drop: { no_permalink: 0, no_comment_btn: 0, fb_translated: 0, not_vietnamese: 0, tier_general: 0 },
    // Lý do loại ở tầng SINH comment (sau khi bài đã lọt mọi cửa nội dung).
    // filter_drop cho biết mất bài ở đâu; bảng này cho biết mất COMMENT ở đâu.
    gen_reject: { bad_output: 0, echo: 0, self_name: 0, fake_stat: 0, fake_domain: 0, may_moc: 0, quality_gate: 0 },
    no_link_samples: [],
    ai_eval_n: 0, ai_ad_n: 0, ai_verdicts: [] }
  const actionRows = []

  // BẤM GIỜ TỪ ĐÂY, không phải sau khi mở browser.
  //
  // Deadline cũ đặt sau getPage + tạo feed_sessions + mở feed. Mở browser lạnh
  // (khởi động Chromium, nạp cookie, điều hướng) tốn vài phút, quãng đó KHÔNG
  // được tính → 7 phút "của handler" cộng thêm phần khởi tạo thành hơn 10 phút
  // và poller huỷ job (đo 25/08 qua health-check: feed_seed + check_replies mỗi
  // loại 1 job bị huỷ dù đã có deadline). Ngân sách phải tính trọn đời job vì
  // đồng hồ 10 phút của poller cũng tính trọn đời job.
  // 7→12 phút (04/09, user "liên tục onl load newsfeed để lấy bài"): trần 7'
  // đặt thời started_at bị heartbeat reset (job >10' bị chém). Nay cleanup đã
  // theo nhịp tim (job còn heartbeat = sống) nên nới được — thêm 5 phút chủ
  // yếu cho vòng THU THẬP, phễu đói bài là nút cổ chai số 1 của cả comment
  // lẫn quảng cáo (đo 04/09: 0-4 ứng viên/phiên → xếp 0-3 comment).
  const deadline = Date.now() + 12 * 60 * 1000

  // CHIA GIAI ĐOẠN ngân sách thời gian (27/08). Trước đây chỉ có một mốc
  // `deadline` dùng chung cho CẢ vòng thu thập lẫn AI-eval lẫn sinh comment.
  // Vòng thu thập lại chạy tới khi đủ `limit * 6` ứng viên — với limit 13 là 78
  // bài, con số không bao giờ đạt — nên nó ngốn trọn 7 phút, và bước AI-eval
  // phía sau có điều kiện `Date.now() < deadline` thành sai → BỊ BỎ QUA LẶNG LẼ.
  // Đo thật: phiên 27/08 ra ai_eval_n=0, nick comment vào bài bóng đá/vali/kem
  // dưỡng da vì không còn tầng AI nào lọc.
  // Nay: thu thập chỉ được dùng tới mốc riêng, chừa lại 3 phút cho AI-eval +
  // sinh comment. Không nới `deadline` lên quá 7 phút vì poller huỷ job ở mốc
  // 10 phút trọn đời job (xem ghi chú ngay trên).
  const mocThuThap = deadline - 4 * 60 * 1000   // ~8' thu thập, 4' cho AI + sinh

  try {
    const sess = await getPage(account)
    const page = sess.page

    const { data: created } = await supabase.from('feed_sessions').insert({
      user_id: account.owner_id, account_id, job_id: job_id || null,
      session_kind: 'feed_seed', status: 'running',
    }).select('id')
    sessionRow = created && created[0]

    console.log(`[FEED-SEED] ${account.username} — tối đa ${limit} comment, quảng cáo đã dùng ${adCommentsToday}/${adCap}${dry_run ? ' (CHẠY THỬ)' : ''}`)

    await page.goto(FEED_URL, { waitUntil: 'domcontentloaded', timeout: 45000 })
    await R.sleepRange(4000, 7000)

    const blocked = await page.evaluate(getBlockDetectionScript())
    if (blocked.blocked) {
      // CẦU DAO: không chỉ pause nick mà HUỶ luôn mọi job đang chờ + thông báo
      // → không để job comment khác của nick tiếp tục đổ dầu vào lửa.
      await guard.tripBreaker(supabase, account_id, `feed_block:${blocked.reason}`, {
        jobId: job_id, ownerId: account.owner_id, recordSignal,
      })
      throw new Error(`CIRCUIT_BREAKER_TRIPPED: feed_block:${blocked.reason}`)
    }
    await humanMouseMove(page)

    // ── 3. Ngữ cảnh loại trừ ──
    const { data: ownNicks } = await supabase.from('accounts').select('fb_user_id')
    // MỚI NHẤT TRƯỚC (sửa 07/09): trước đây `.limit(500)` KHÔNG kèm order —
    // Postgres trả 500 dòng theo thứ tự vật lý (thường là cũ nhất), nên khi
    // nick vượt 500 bản ghi (đo thật: 564) thì đúng những bài VỪA comment —
    // thứ dễ gặp lại nhất trên feed — lại nằm ngoài danh sách loại trừ. Hậu
    // quả: chọn lại bài cũ, tốn lượt sinh AI, rồi vỡ unique index khi ghi log.
    const { data: commented } = await supabase.from('feed_actions')
      .select('target_fb_post_id').eq('account_id', account_id)
      .eq('action_type', 'comment')
      .order('created_at', { ascending: false })
      .limit(1000)
    const { data: exclusions } = await supabase.from('feed_exclusions')
      .select('*').eq('user_id', account.owner_id).eq('is_active', true)

    const exCtx = buildExclusionContext({
      ownNickFbIds: (ownNicks || []).map(x => x.fb_user_id).filter(Boolean),
      commentedPostIds: (commented || []).map(x => x.target_fb_post_id).filter(Boolean),
      exclusions: exclusions || [],
    })

    // NGÂN SÁCH THỜI GIAN 8 phút — poller huỷ job chạy >10 phút ("execution
    // exceeded 10m timeout"). feed_seed quét feed + gọi AI (generate+gate) cho
    // nhiều candidate, DeepSeek chậm 10-50s/lần → dễ vượt 10 phút → bị huỷ → 0
    // comment (bug thật 22/08: phiên 09:12 timeout). Deadline 8 phút cho feed_seed
    // dừng sớm + xếp comment đã sinh + thoát sạch, thay vì bị giết mất trắng.

    // ── 4. Thu thập ứng viên. CHỈ nhận bài có permalink —
    //     comment_post cần post_url để điều hướng sang m.facebook.com. ──
    let storyThu = 0   // trần thử nghiệm bài /stories/ mỗi phiên
    let generalN = 0   // số bài 'general' đã nhận vào rọ ứng viên phiên này
    const candidates = []
    await feedDom.scrollAndCollect(page, {
      scrolls: 45,
      dwellMs: [4000, 7000],
      // limit*2 (không phải *6): chỉ cần dư ứng viên để AI + các guard loại bớt,
      // xin nhiều hơn chỉ tổ đốt hết thời gian của hai bước sau.
      shouldStop: () => candidates.length >= limit * 2 || Date.now() > mocThuThap,
      onBatch: (fresh) => {
        for (const p of fresh) {
          stats.scanned++
          const drop = stats.filter_drop
          if (!p.link || !p.fbPostId || String(p.fbPostId).startsWith('syn_')) {
            drop.no_permalink++
            // Giữ vài mẫu href thật để biết Facebook đang render link kiểu gì
            // — cửa này loại 33% số bài, không có mẫu thì chỉ đoán mò selector.
            if (stats.no_link_samples.length < 6 && p.hrefSample && p.hrefSample.length) {
              stats.no_link_samples.push(p.hrefSample.join(' | '))
            }
            continue
          }
          if (!p.canComment) { drop.no_comment_btn++; continue }
          // BÀI ĐƯỢC FACEBOOK TỰ DỊCH → bài GỐC là ngoại ngữ.
          // Thân bài đọc ra là tiếng Việt (bản dịch) nên isVietnamese() bên dưới
          // sẽ cho qua; phải chặn TRƯỚC. Không chặn thì nick comment tiếng Việt
          // dưới bài tiếng Bồ/Anh/Trung — đúng lỗi user báo 25/08 kèm ảnh chụp.
          if (p.isTranslated) { drop.fb_translated++; continue }
          // CHỈ COMMENT BÀI TIẾNG VIỆT. Nick VN comment tiếng Việt vào bài tiếng
          // Trung/Anh/Nhật = lệch ngôn ngữ, nhìn như bot. LIKE thì không lọc
          // (feed_scroll vẫn like bài tech mọi ngôn ngữ để dạy thuật toán).
          if (!isVietnamese(p.text)) { drop.not_vietnamese++; continue }
          const sc = screenPost({
            fbPostId: p.fbPostId, authorFbId: p.authorFbId,
            authorType: p.authorType, text: p.text, isAd: p.isAd,
          }, exCtx, niche, affinity)
          if (!sc.eligible) {
            // Gộp theo NHÓM lý do (bỏ phần sau dấu ':') để bảng đếm đọc được,
            // thay vì nở ra hàng chục khoá kiểu negative_keyword:<từng từ>.
            const k = 'screen_' + String(sc.reason || 'other').split(':')[0]
            drop[k] = (drop[k] || 0) + 1
            continue
          }
          // COMMENT bài đúng ngách (niche) HOẶC bài tech (interest) — cả hai đều
          // đúng "chất" nick công nghệ nên không lạc đề. CHỈ chặn 'general' (bài
          // ngoài luồng tech: tâm sự, bán hàng lặt vặt...) vì comment vào đó vừa
          // lạc chủ đề vừa nhìn như bot. Bài tech tự thành organic (không khớp
          // sản phẩm VPS → feed-ad-strategy cho organic), không sợ quảng cáo bậy.
          // Bật comment cả bài general bằng niche.comment_general_posts=true.
          // BÀI 'general' (ngoài luồng tech: tâm sự, giao lưu, bán hàng lặt vặt).
          //
          // Trước 27/08 chặn thẳng — và đây là cửa loại NHIỀU NHẤT (đo thật:
          // 66/190 bài). Với chỉ tiêu 50 comment/ngày thì chặn hết bài general
          // là không đủ ứng viên: phễu chỉ ra 2-6 ứng viên/phiên.
          // Nay cho vào rọ ứng viên nhưng KHÔNG thả nổi — chúng còn phải qua:
          //   1. AI post_eval (action=skip loại bài spam/quảng cáo/đối thủ)
          //   2. FAR_CAP — general xếp campRank 3, nằm cuối, chỉ lấp phần thiếu
          //   3. quality_gate khi sinh comment
          // Đặt trần riêng để một phiên feed toàn bài tâm sự không đẩy hết bài
          // tech ra khỏi rọ. niche.comment_general_posts=false để chặn lại hẳn.
          if (sc.tier === 'general') {
            if (niche.comment_general_posts === false) { drop.tier_general++; continue }
            if (generalN >= Math.ceil(limit * 0.3)) { drop.tier_general_capped = (drop.tier_general_capped || 0) + 1; continue }
            generalN++
          }
          // adjacency = mức GẦN HƯỚNG CAMP. niche luôn gần; interest chỉ gần khi
          // khớp từ HIGH_AFFINITY (VPS/hạ tầng/devops). Dùng để ưu tiên chọn &
          // comment bài gần camp, bớt sa đà AI-chat thuần (user 22/08).
          const adjacent = sc.tier === 'niche' || (sc.tier === 'interest' && isHighAffinity(sc.matched, affinity))

          // BÀI XA CAMP (AI-chat thuần, coding xa, general): CHỈ nhận khi CÓ CÂU HỎI hoặc VẤN ĐỀ/PAIN POINT.
          // Tránh xa các bài khoe prompt, chia sẻ vu vơ, đời sống ("Nhờ ChatGPT chọn kiểu tóc...", "Thử prompt này xem").
          // Comment vào các bài đó vừa lạc đề vừa sinh ra comment ngớ ngẩn (user 10/09).
          const hasPainOrQuestion = coChoDeNoi(p.text) || /\?|cho (mình|em) hỏi|ai (biết|dùng|từng|cho xin)|nhờ tư vấn|tư vấn giúp|cần (tìm|mua|thuê|tư vấn|hỗ trợ)|bị lỗi|làm sao|xin ý kiến|cứu em/i.test(p.text || '')
          if (!adjacent && sc.tier !== 'niche' && !hasPainOrQuestion) {
            drop.no_pain_point = (drop.no_pain_point || 0) + 1
            continue
          }

          // Bài /stories/ CÓ id thật (giải từ base64) nhưng CHƯA kiểm chứng là
          // URL đó mở ra bài có ô comment hay mở ra khung xem story. Cho thử
          // TỐI ĐA 1 bài mỗi phiên: đủ để biết kết quả thật qua comment_post,
          // mà hỏng thì cũng chỉ mất 1 lượt. Bỏ cap khi đã có bằng chứng chạy được.
          //
          // Đặt SAU mọi cửa lọc: để trước thì bài story rớt ở cửa ngôn ngữ/ngách
          // vẫn tiêu mất suất thử nghiệm của phiên, đo mãi không ra kết quả.
          if (p.linkKind === 'story') {
            if (storyThu >= 1) { drop.story_capped = (drop.story_capped || 0) + 1; continue }
            storyThu++
            drop.story_thu = (drop.story_thu || 0) + 1
          }
          candidates.push({ post: p, tier: sc.tier, matched: sc.matched, adjacent })
        }
      },
    })

    // Ưu tiên theo mức GẦN HƯỚNG CAMP (user: "tìm và lựa nhiều hơn"):
    //   0 niche (VPS đúng ngách) → 1 interest+adjacent (hạ tầng/devops, kề camp)
    //   → 2 interest xa (AI-chat/content/coding thuần) → 3 general.
    // Bài gần camp được AI-eval + comment TRƯỚC (trong giới hạn phiên), bài AI
    // thuần chỉ lấp chỗ khi thiếu bài gần → mix comment nghiêng về camp.
    const campRank = (cd) => {
      if (cd.tier === 'niche') return 0
      if (cd.tier === 'interest') return cd.adjacent ? 1 : 2
      return 3
    }
    candidates.sort((a, b) => {
      const ra = campRank(a), rb = campRank(b)
      if (ra !== rb) return ra - rb
      return b.post.text.length - a.post.text.length
    })
    let adjacentN = candidates.filter(c => c.adjacent).length
    stats.cand_near = adjacentN
    stats.cand_far = candidates.length - adjacentN
    console.log(`[FEED-SEED] Ứng viên: ${candidates.length} (gần camp ${adjacentN}, xa ${candidates.length - adjacentN})`)

    // ── 4a. SĂN BÀI CÓ NGƯỜI ĐANG HỎI (06/09, user "quảng cáo gượng ép, quá ít") ──
    //
    // Nghịch lý phải gỡ: quảng cáo VỪA ít VỪA gượng. Gốc là chọn SAI CHỖ —
    // newsfeed cá nhân chủ yếu là bài kể chuyện/chia sẻ, nhét thương hiệu vào
    // đó thì câu nào cũng gượng, mà siết lại thì gần như không còn quảng cáo.
    // Chỗ nhắc thương hiệu KHÔNG BAO GIỜ gượng là dưới bài NGƯỜI TA ĐANG HỎI
    // ("cần mua vps giá rẻ", "hosting nào ổn", "server hay sập"): ở đó nói tên
    // dịch vụ mình xài chính là trả lời câu hỏi.
    // Nick vốn đã vào trang tìm kiếm mỗi phiên (cú lặn 03/09) nhưng chỉ đọc rồi
    // bỏ đi — đúng mỏ vàng mà không thu hoạch. Nay: quét luôn kết quả tìm kiếm,
    // giữ lại bài THẬT SỰ có nhu cầu/vấn đề (coChoDeNoi), xếp lên đầu hàng.
    // Comment vẫn đăng qua comment_post trên permalink bài như mọi bài khác —
    // không bấm gì trên trang search, nên không đụng DOM lạ.
    try {
      const thieuGanCamp = limit - adjacentN
      const conGio = Date.now() < mocThuThap
      if (thieuGanCamp > 0 && conGio) {
        const kws = (Array.isArray(niche.target_keywords) && niche.target_keywords.length)
          ? niche.target_keywords : ['vps', 'hosting']
        const kw = kws[Math.floor(Math.random() * kws.length)]
        // Truy vấn kiểu người đang cần, không phải từ khoá trần — kết quả trả
        // về mới là bài hỏi mua/nhờ tư vấn thay vì bài quảng cáo của đối thủ.
        const mauTruyVan = [`cần mua ${kw}`, `tư vấn ${kw}`, `${kw} nào tốt`, `${kw} nào ổn`, `thuê ${kw}`]
        const truyVan = mauTruyVan[Math.floor(Math.random() * mauTruyVan.length)]
        console.log(`[FEED-SEED] Săn bài có người hỏi: "${truyVan}" (thiếu ${thieuGanCamp} bài gần camp)`)
        await page.goto(`https://www.facebook.com/search/posts?q=${encodeURIComponent(truyVan)}`,
          { waitUntil: 'domcontentloaded', timeout: 45000 })
        await R.sleepRange(4000, 7000)

        const hetGio = Date.now() + 90 * 1000   // ngân sách riêng 90 giây
        let thuThap = 0
        const baiSearch = await feedDom.scrollAndCollect(page, {
          scrolls: 8,
          dwellMs: [3000, 5000],
          shouldStop: () => Date.now() > hetGio || thuThap >= 25,
          onBatch: (fresh) => { thuThap += fresh.length },
        })
        stats.san_search = { truy_van: truyVan, thu: baiSearch.length, giu: 0 }

        for (const p of baiSearch) {
          if (candidates.filter(c => c.adjacent).length >= limit) break
          if (!p.link || !p.fbPostId || String(p.fbPostId).startsWith('syn_')) continue
          if (p.isTranslated || !isVietnamese(p.text)) continue
          if (!coChoDeNoi(p.text)) continue          // phải THẬT SỰ đang hỏi / gặp vấn đề
          const sc = screenPost({
            fbPostId: p.fbPostId, authorFbId: p.authorFbId,
            authorType: p.authorType, text: p.text, isAd: p.isAd,
          }, exCtx, niche, affinity)
          if (!sc.eligible) continue
          if (candidates.some(c => c.post.fbPostId === p.fbPostId)) continue
          // Bài từ đường săn LUÔN tính là gần camp: nó khớp đúng nhu cầu ngách
          // và đã qua screenPost, nên xứng đáng đứng đầu hàng chờ comment.
          candidates.push({ post: p, tier: sc.tier, matched: sc.matched, adjacent: true, nguon: 'search' })
          stats.san_search.giu++
        }
        console.log(`[FEED-SEED] Săn: thu ${baiSearch.length} bài, giữ ${stats.san_search.giu} bài có nhu cầu thật`)

        // Quay lại newsfeed để phần sau của phiên chạy trên DOM quen thuộc
        await page.goto(FEED_URL, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {})
        await R.sleepRange(2000, 4000)

        adjacentN = candidates.filter(c => c.adjacent).length
        stats.cand_near = adjacentN
        stats.cand_far = candidates.length - adjacentN
      }
    } catch (e) {
      stats.san_search = { loi: String(e.message).slice(0, 120) }
      console.warn(`[FEED-SEED] Săn bài có người hỏi bỏ qua: ${e.message}`)
    }

    // ── 4b. AI CHẤM AD-OPPORTUNITY theo NGỮ CẢNH (user: "để AI tự quyết bài nào
    //     có context đủ để quảng cáo, bài nào cmt bình thường"). 1 call batch cho
    //     tối đa 8 candidate đầu — evaluatePosts đọc toàn bộ nội dung, trả
    //     ad_strategy (pitch/recommend/seed/organic) + score. Kết quả đưa vào
    //     decideAdStrategy (nhánh AI-mode). AI fail → aiEvalMap rỗng → fallback
    //     keyword như cũ (fail-safe organic). ──
    const aiEvalMap = {}
    // BỎ ĐIỀU KIỆN niche.ad_enabled (27/08): evaluatePosts giờ không chỉ chấm cơ
    // hội quảng cáo mà còn là NƠI AI CHỌN BÀI ĐÁNG COMMENT (user 27/08). Nick
    // tắt quảng cáo vẫn cần AI lọc bài, nên không được khoá sau cổng quảng cáo.
    // Chấm rộng hơn 8 bài: chỉ tiêu phiên đã lên ~13 nên 8 là chấm hụt.
    // Bỏ qua AI-eval phải để LẠI DẤU VẾT. Lần hỏng 27/08 im hoàn toàn: kết quả
    // job chỉ có ai_eval_n=0 — trông y hệt "AI chấm xong, không thấy gì".
    if (!candidates.length) {
      stats.ai_skip_ly_do = 'không có ứng viên'
    } else if (Date.now() >= deadline) {
      stats.ai_skip_ly_do = 'hết ngân sách thời gian trước khi kịp chấm'
      console.warn('[FEED-SEED] ⚠ BỎ QUA AI chọn bài: hết giờ — comment sẽ KHÔNG được AI lọc')
    }
    if (candidates.length && Date.now() < deadline) {
      try {
        const evalSet = candidates.slice(0, Math.max(limit * 2, 16))

        // CHẤM THEO LÔ 8 BÀI — KHÔNG gộp một lần.
        //
        // Phản hồi của model bị chặn ở ~5.100 ký tự (max_tokens trong
        // hermes_config). Đo thật 27/08: lô 8 bài trả 4.833 ký tự → parse OK;
        // lô 13 và 26 bài đều vượt trần, JSON đứt giữa chừng, ai-brain ném
        // "No JSON array in AI response — likely truncated". Cả cụm try bị
        // catch nuốt → aiEvalMap rỗng → KHÔNG có tầng AI nào lọc bài, mà job
        // vẫn báo success. Đây chính là lý do phiên đầu 27/08 comment vào bài
        // bóng đá và Ngày Quốc tế chó.
        // Bắt lỗi TỪNG LÔ để một lô hỏng không thổi bay kết quả các lô khác.
        const CO_LO = 8
        let loHong = 0
        for (let i = 0; i < evalSet.length; i += CO_LO) {
          if (Date.now() >= deadline) { stats.ai_lo_bo_dt = (stats.ai_lo_bo_dt || 0) + 1; continue }
          const lo = evalSet.slice(i, i + CO_LO)
          try {
            const evals = await aiBrain.evaluatePosts({
              posts: lo.map(cd => ({ author: cd.post.author, text: cd.post.text })),
              campaign: null,
              nick: { username: account.username, account_id },
              group: { name: 'Bảng tin' },
              topic: niche.niche,
              maxPicks: lo.length,
              ownerId: account.owner_id,
              brandConfig: {
                brand_name: niche.brand_name,
                brand_description: niche.brand_description,
                products: niche.products || [],
              },
              groupLanguage: 'vi',
            })
            for (const ev of evals || []) {
              const cd = lo[ev.index - 1]
              if (cd) aiEvalMap[cd.post.fbPostId] = ev
            }
          } catch (e) {
            loHong++
            console.warn(`[FEED-SEED] Lô AI-eval ${i / CO_LO + 1} hỏng: ${e.message}`)
          }
        }
        if (loHong) stats.ai_lo_hong = loHong
        // AI CHỌN BÀI: bỏ hẳn bài AI chấm action="skip" (bài spam, quảng cáo của
        // người khác, bài đối thủ, sai ngôn ngữ). Trước đây verdict này bị bỏ
        // phí — chỉ ad_strategy được dùng — nên nick vẫn comment vào bài AI đã
        // thấy không đáng. Chỉ lọc trong phạm vi đã chấm; bài ngoài evalSet giữ
        // nguyên để không mất ứng viên khi AI chấm hụt.
        const daCham = new Set(evalSet.map(cd => cd.post.fbPostId))
        const truocLoc = candidates.length

        // NGƯỠNG ĐIỂM. Prompt post_eval chấm thang 1-10 và chỉ trả action="skip"
        // cho bài spam/quảng cáo đối thủ (1-2); bài tán gẫu lạc đề vẫn được 3-4
        // kèm action="comment" vì thang điểm đó viết cho campaign trong NHÓM,
        // nơi hoà đồng với thành viên là đúng. Trên BẢNG TIN với nick ngách
        // VPS thì bài "Ngày Quốc tế chó" hay "vali giảm giá" chỉ tạo comment vô
        // nghĩa — đo thật 27/08. Nên chặn thêm theo điểm.
        // Chỉnh bằng niche.feed_min_score: hạ xuống 3 nếu cần sản lượng cao hơn
        // và chấp nhận nhiều bài lạc đề.
        const nguongDiem = Number.isFinite(niche.feed_min_score) ? niche.feed_min_score : 4
        for (let i = candidates.length - 1; i >= 0; i--) {
          const ev = aiEvalMap[candidates[i].post.fbPostId]
          if (!ev) continue
          const diem = Number.isFinite(ev.score) ? ev.score : null
          // Bài GENERAL (ngoài luồng tech) đòi điểm cao hơn (01/09, user "quảng
          // cáo chưa đúng chỗ, cần hiểu context"): ngưỡng chung 4 để đủ sản
          // lượng bài tech, nhưng với bài tâm sự/mua bán lặt vặt thì 4-5 điểm
          // vẫn ra comment lạc quẻ — đo thật: nick tech đi tư vấn cặp sách trẻ
          // con, trả lời hộ bài "hỏi anh Quang về thanh toán". Bài general phải
          // THẬT SỰ đáng nói (≥6) mới cho vào.
          // 6→7 (03/09): gate 6 vẫn lọt "tựu trường sốt xuất huyết"/"tài chính
          // Day 137" — bài general phải XUẤT SẮC mới đáng cho nick tech lên tiếng.
          const nguong = candidates[i].tier === 'general' ? Math.max(nguongDiem, 7) : nguongDiem
          if (String(ev.action) === 'skip' || (diem !== null && diem < nguong)) {
            candidates.splice(i, 1)
          }
        }
        stats.ai_min_score = nguongDiem
        stats.ai_skip_n = truocLoc - candidates.length
        if (stats.ai_skip_n) {
          console.log(`[FEED-SEED] AI loại ${stats.ai_skip_n}/${daCham.size} bài (action=skip)`)
        }

        const adCount = Object.values(aiEvalMap).filter(e => e.ad_strategy && e.ad_strategy !== 'organic').length
        stats.ai_eval_n = Object.keys(aiEvalMap).length
        stats.ai_ad_n = adCount
        // Lưu verdict gọn để biết AI đang từ chối quảng cáo VÌ SAO
        stats.ai_verdicts = Object.values(aiEvalMap).slice(0, 8).map(e => ({
          s: e.ad_strategy || '?', t: e.tier ?? null, sc: e.score ?? null,
          r: String(e.ad_reason || e.reason || '').slice(0, 60),
        }))
        console.log(`[FEED-SEED] AI ad-eval: ${Object.keys(aiEvalMap).length} bài chấm, ${adCount} bài AI thấy đủ context quảng cáo`)
        // Re-sort: bài AI thấy cơ hội ad lên ĐẦU (ưu tiên quảng bá brand camp),
        // rồi tới mức GẦN CAMP (campRank) làm tiebreaker để bài gần vẫn trên bài
        // AI-chat xa khi cùng không phải ad.
        const adRank = (cd) => {
          const ev = aiEvalMap[cd.post.fbPostId]
          if (!ev || !ev.ad_strategy || ev.ad_strategy === 'organic') return 0
          return Number.isFinite(ev.score) ? ev.score : 5
        }
        candidates.sort((a, b) => {
          const d = adRank(b) - adRank(a)
          if (d !== 0) return d
          return campRank(a) - campRank(b)
        })
      } catch (e) {
        console.warn(`[FEED-SEED] AI ad-eval lỗi: ${e.message} — fallback keyword matching`)
      }
    }
    // ĐẾM LẠI sau khi AI đã loại bài — adjacentN ở trên là số TRƯỚC lọc. Không
    // đếm lại thì FAR_CAP bên dưới xài số cũ (nới quá tay), và kết quả job tự
    // mâu thuẫn: phiên 27/08 báo ứng viên 6 nhưng cand_far 12.
    adjacentN = candidates.filter(c => c.adjacent).length
    stats.cand_near = adjacentN
    stats.cand_far = candidates.length - adjacentN
    stats.candidates = candidates.length
    console.log(`[FEED-SEED] ${stats.scanned} bài quét → ${candidates.length} ứng viên (ngành: ${candidates.filter(c => c.tier === 'niche').length})`)

    // ── 5. Sinh comment + kiểm duyệt + xếp hàng ──
    //
    // VÒNG TỰ-HỌC (self-improvement, SaaS): mọi comment feed gửi feedback về
    // Hermes — daily-review 23:00 dùng điểm này để rewrite skill comment_gen,
    // purge feedback xấu, chỉnh quality gate. Trước đây CHỈ campaign gửi → feed
    // farming bị loại khỏi vòng học cả hệ. Nay feed đóng góp + hưởng lợi từ vòng
    // học. fire-and-forget, không chặn luồng. context có tier/ngách để học đúng.
    const learnFeedback = (text, score, reason, cand) => {
      try {
        hermes.sendFeedback({
          taskType: 'comment_gen', outputText: text || '', score,
          accountId: account_id, reason,
          context: { source: 'newsfeed', tier: cand?.tier || null, matched: cand?.matched || null, niche: niche.niche },
        })
      } catch {}
    }
    let adUsed = adCommentsToday
    let adBoostsUsed = 0   // số lượt nâng organic→seed trong phiên (trần 2)
    // Mốc thời gian cộng dồn cho các job comment_post (xem chú thích chỗ dùng).
    //
    // KHỞI ĐIỂM = muộn hơn giữa (bây giờ) và (comment đã hẹn MUỘN NHẤT còn
    // pending của nick này). Nếu chỉ lấy Date.now() thì mỗi phiên feed_seed xếp
    // từ mốc riêng → comment của 2 phiên ĐÈ NHAU (thực đo: 22:17 và 22:22 cách
    // 5 phút, phá vỡ giãn cách 45-90 phút). Nối tiếp hàng đợi cũ → giãn cách
    // ngẫu nhiên được giữ liên tục XUYÊN các phiên, không dồn cục.
    let nextCommentAt = Date.now()
    try {
      const { data: lastPending } = await supabase.from('jobs')
        .select('scheduled_at')
        .eq('type', 'comment_post')
        .eq('status', 'pending')
        .eq('payload->>account_id', account_id)
        .order('scheduled_at', { ascending: false })
        .limit(1)
      const lastAt = lastPending?.[0]?.scheduled_at ? new Date(lastPending[0].scheduled_at).getTime() : 0
      if (lastAt > nextCommentAt) {
        nextCommentAt = lastAt
        console.log(`[FEED-SEED] Nối tiếp hàng đợi: comment kế sẽ xếp sau ${new Date(lastAt).toLocaleTimeString()}`)
      }
    } catch (e) {
      console.warn(`[FEED-SEED] Không đọc được hàng đợi comment cũ: ${e.message} — xếp từ bây giờ`)
    }
    // "Lựa nhiều hơn" (user 22/08) → SIẾT 26/08 ("CẦN tương tác bài VPS/hosting"):
    // trần cũ max(2, số bài gần) để lọt 2 comment xa cả khi phiên KHÔNG có bài
    // gần nào → 48h đo được 9/13 comment rơi vào AI/coding thuần. Giờ: comment
    // xa không vượt số bài gần (trần 2); phiên trắng bài gần chỉ cho 1 comment
    // xa để nick không im hẳn trong lúc feed còn nghèo bài VPS.
    // Trần cũ (min(số bài gần, 2), phiên trắng bài gần cho 1) được đặt khi chỉ
    // tiêu là 2-5 comment/phiên. Với chỉ tiêu ~13/phiên nó khoá cứng phiên ở 2
    // comment mỗi khi feed nghèo bài VPS — mà feed nghèo bài VPS là chuyện
    // thường ngày. Nay cho trần trượt theo chỉ tiêu: ưu tiên bài gần camp
    // trước (candidates đã sort), bài xa chỉ lấp phần còn thiếu, tối đa 60%
    // phiên — vẫn nghiêng về camp nhưng không còn chặn cứng sản lượng.
    // 60%→30% (03/09, user "cmt vào bài k liên quan"): đo 14h comment toàn
    // Obsidian/tiếng Nhật/tài chính/tựu trường — mix nghiêng hẳn về xa camp.
    // Thà ít comment mà đúng chất còn hơn nhiều mà lạc đề.
    const FAR_CAP = Math.max(1, Math.min(limit - adjacentN, Math.ceil(limit * 0.3)))
    let farQueued = 0
    for (const cand of candidates) {
      if (stats.queued >= limit) break
      // Hết ngân sách thời gian → dừng sinh thêm, xếp những gì đã có rồi thoát
      // sạch (tránh bị poller huỷ ở mốc 10 phút làm mất trắng cả phiên).
      if (Date.now() > deadline) {
        console.log(`[FEED-SEED] Hết ngân sách 8 phút — dừng sớm, đã xếp ${stats.queued} comment`)
        break
      }
      // Bỏ qua bài xa camp khi đã đủ hạn mức xa của phiên (candidates đã sort
      // gần→xa nên các bài gần luôn được xét trước).
      if (!cand.adjacent && farQueued >= FAR_CAP) {
        stats.far_capped++
        continue
      }
      const { post } = cand

      // Quyết định quảng cáo cho ĐÚNG bài này. Truyền nickAge để trần AUTO
      // (daily_ad_comments=null) nới đúng theo tuổi nick. aiEval (nếu có) là
      // phán quyết ngữ cảnh của AI — decideAdStrategy nhánh AI-mode dùng nó.
      let decision = decideAdStrategy(
        { text: post.text }, niche,
        // baiNhuCau: bài nick tự săn được từ trang tìm kiếm — người ta ĐANG hỏi,
        // nên nhắc dịch vụ là trả lời chứ không phải chèn quảng cáo (06/09).
        { adCommentsToday: adUsed, nickAge, baiNhuCau: cand.nguon === 'search' },
        aiEvalMap[post.fbPostId] || null
      )
      // BÙ THIẾU QUẢNG CÁO (01/09): AI chấm organic nhưng cả ngày đang hụt xa
      // nhịp trần → nâng bài GẦN CAMP điểm khá lên seed (nhắc brand mềm). Tối
      // đa 2 lượt nâng/phiên để "ưu tiên 1 chút" chứ không lật kèo cả phiên.
      // Điều kiện chi tiết nằm trong boostForDeficit (pure, test offline được).
      if (!decision.isAd && adBoostsUsed < 2) {
        const boosted = boostForDeficit({ text: post.text }, niche, {
          cap: adCap, used: adUsed, adjacent: cand.adjacent,
          aiEval: aiEvalMap[post.fbPostId] || null,
        })
        if (boosted) {
          decision = boosted
          adBoostsUsed++
          stats.ads_boosted++
          console.log(`[FEED-SEED] ⬆ Nâng organic→seed bù nhịp quảng cáo (${boosted.reason})`)
        }
      }
      if (decision.isAd) stats.ads_attempted++   // đếm CƠ HỘI (trước gate) — phân biệt "không có cơ hội" vs "bị gate loại"
      const cp = buildCommentParams(decision, niche)

      // Chủ đề chấm điểm theo HẠNG bài — DÙNG CHUNG generation VÀ quality gate.
      // BUG THUẬT TOÁN (audit 21/08): generation dùng topic đúng tier nhưng gate
      // hardcode niche.niche (VPS/Hosting) → comment tech (interest) bị gate LOẠI
      // OAN "không liên quan VPS/Hosting" (đo thật: 4 skip/ngày, phí cả lượt sinh AI).
      // Nay 1 biến dùng cả 2 chỗ → gate chấm đúng chủ đề comment thật sự bám.
      const commentTopic = cand.tier === 'niche' ? niche.niche
                         : cand.tier === 'interest' ? 'công nghệ'
                         : 'trò chuyện thân thiện'

      // AI có lúc trả rác: chuỗi "empty", "null", 1-2 từ vô nghĩa. Quality gate
      // KHÔNG chặn được (nhánh too_short trả object thiếu score → lọt heuristic_pass),
      // nên phải chặn ngay tại đây. Đã quan sát thật: AI trả đúng chữ "empty".
      const laRac = (g) => !g || !g.text ||
        g.text.trim().length < 15 ||
        /^(empty|null|undefined|n\/a|none|không|khong)\.?$/i.test(g.text.trim()) ||
        looksLikeMetaOutput(g.text) ||   // model trả suy luận/meta thay vì comment (leak thật 23/06)
        looksTruncated(g.text)           // câu đứt ngang "...ai cũng" (đăng thật 01/09) — thử lại 1 lần

      // Sinh comment — THỬ LẠI 1 LẦN nếu ra rác.
      // qwen3.8 trả rỗng khoảng 1-2 lượt trên 6 (đo 27/08). Mỗi lượt rỗng ăn
      // mất một suất trong chỉ tiêu phiên dù bài vẫn dùng được, nên bỏ luôn là
      // phí. Chỉ thử lại 1 lần: rác hai lần liên tiếp thường là do BÀI (quá
      // ngắn, toàn ảnh) chứ không phải model, thử nữa cũng vô ích và tốn giờ.
      let gen = null
      for (let luot = 1; luot <= 2; luot++) {
        gen = await aiBrain.generateSmartComment({
          postText: post.text,
          postAuthor: post.author,
          group: { name: 'Bảng tin' },        // ai-brain cần trường này; feed không thuộc nhóm nào
          campaign: null,
          nick: { username: account.username, created_at: account.created_at, mission: niche.persona },
          topic: commentTopic,
          ownerId: account.owner_id,
          language: 'vi',
          adStrategy: cp.adStrategy,
          hasAdOpportunity: cp.hasAdOpportunity,
          matchedProduct: cp.matchedProduct,
          brandConfig: cp.brandConfig,
        })
        if (!laRac(gen)) break
        if (luot === 1) {
          stats.gen_retry = (stats.gen_retry || 0) + 1
          console.log(`[FEED-SEED] Comment ra rác, sinh lại lần 2 cho bài ${String(post.fbPostId).slice(0, 12)}`)
        }
      }

      const badOutput = laRac(gen)

      if (badOutput) {
        stats.rejected++; stats.gen_reject.bad_output++
        learnFeedback(gen && gen.text, 1, 'ai_bad_output', cand)   // tệ nhất → điểm 1
        actionRows.push({
          user_id: account.owner_id, session_id: sessionRow?.id, account_id,
          action_type: 'comment', target_fb_post_id: post.fbPostId, post_url: post.link,
          post_snippet: post.text.slice(0, 200), is_suggested: post.isSuggested,
          comment_text: gen && gen.text ? gen.text.slice(0, 100) : null,
          status: 'skipped',
          skip_reason: `ai_bad_output:${gen && gen.text ? gen.text.trim().slice(0, 20) : 'empty'}`,
        })
        continue
      }
      stats.generated++

      // CHỐNG ECHO: loại comment chỉ NHẠI LẠI bài gốc (copy số liệu/dữ kiện tác
      // giả đã nêu, trùng >45% từ) — người thật không đọc-lại số liệu vừa đọc,
      // đó là dấu hiệu bot rõ rệt. Trước đây chỉ campaign chặn echo, feed KHÔNG
      // → comment "Google Cloud 24.8 tỷ, 20.7%..." (nhại y post) lọt lên. Feedback
      // âm để vòng tự-học phạt pattern nhại.
      const echo = validateCommentNotEcho(gen.text, post.text)
      if (!echo.valid) {
        stats.rejected++; stats.gen_reject.echo++
        learnFeedback(gen.text, 1, `echo_rejected:${echo.reason}`, cand)
        actionRows.push({
          user_id: account.owner_id, session_id: sessionRow?.id, account_id,
          action_type: 'comment', target_fb_post_id: post.fbPostId, post_url: post.link,
          post_snippet: post.text.slice(0, 200), is_suggested: post.isSuggested,
          comment_text: gen.text, matched_keyword: cand.matched || null,
          status: 'skipped', skip_reason: `echo:${echo.reason}`,
        })
        continue
      }

      // GUARD TẤT ĐỊNH (25/08) — hai lỗi mà quality gate AI chấm SÓT, đo thật:
      //  1. Comment tự gọi tên nick ở ngôi thứ ba ("...Lorena cũng đã join rồi")
      //     — gate cho fluency=9, naturalness=9. Người thật không viết vậy.
      //  2. Bịa số % / "gấp N lần" mà bài gốc không hề có ("latency giảm 30%").
      //  3. Bịa TÊN MIỀN bài gốc không nhắc ("Mình cũng thử mv1fD9.com" — đo
      //     thật 26/08). Tên miền của chính brand vẫn được phép (quảng cáo thật).
      // Không phụ thuộc model nên không thể bị chấm sót.
      const selfName = mentionsOwnNick(gen.text, account.username)
      const fakeStat = selfName ? null : fabricatesStat(gen.text, post.text)
      const fakeDomain = (selfName || fakeStat) ? null : fabricatesDomain(gen.text, post.text, brandDomains)
      //  4. Giọng máy móc: xưng "tôi"/"chúng ta", hoặc câu nối phẩy lê thê không
      //     một dấu chấm ngắt ý. Gate AI chấm mấy câu này 8-9 điểm và cho qua
      //     ở cả hai lần siết prompt (27/08) — nên chốt bằng luật.
      const mayMoc = (selfName || fakeStat || fakeDomain) ? null : giongMayMoc(gen.text)
      //  5. SAI TÊN THƯƠNG HIỆU (05/09): model chế "TinoX"/"TinoHost" — thương
      //     hiệu là "Tino". TinoHost còn là đối thủ có thật → quảng cáo hộ họ.
      //  6. KHUÔN QUẢNG CÁO SÁO: "Mình đang xài Tino, ổn áp" dán vào mọi bài,
      //     kể cả bài chẳng liên quan. Cứng đơ, lộ bot ngay.
      const brandName = niche.brand_name || ''
      const prodNames = (niche.products || []).map(p => p?.name).filter(Boolean)
      const saiBrand = (selfName || fakeStat || fakeDomain || mayMoc) ? null : saiTenThuongHieu(gen.text, brandName, prodNames)
      const khuonSao = (selfName || fakeStat || fakeDomain || mayMoc || saiBrand) ? null : khuonQuangCaoSao(gen.text, brandName)
      //  7. QUẢNG CÁO TỰ BÔI XẤU (07/09): khoe dịch vụ mình cũng down/lag ngay
      //     dưới bài người ta đang chán vì hay sập. Ca thật đã đăng 07/09.
      const boiXau = (selfName || fakeStat || fakeDomain || mayMoc || saiBrand || khuonSao) ? null : quangCaoTuBoiXau(gen.text, brandName)
      // BÀI CÓ NGƯỜI HỎI THÌ ĐÁNG THỬ LẠI (06/09): bài săn được rất hiếm (4
      // bài/phiên) và là cơ hội quảng cáo tự nhiên nhất — mất vì MỘT lượt sinh
      // xấu thì quá phí. Đo thật phiên đầu: bài "em có nhu cầu thuê vps 2GB"
      // mất comment chỉ vì model lỡ viết "ổn áp 90%" (bịa số + khuôn sáo).
      // Thử lại đúng 1 lần; lần hai vẫn hỏng thì mới bỏ.
      if ((selfName || fakeStat || fakeDomain || mayMoc || saiBrand || khuonSao || boiXau)
          && cand.nguon === 'search' && !cand._daThuLai) {
        cand._daThuLai = true
        stats.gen_retry = (stats.gen_retry || 0) + 1
        console.log(`[FEED-SEED] Bài có người hỏi bị guard chặn (${selfName || fakeStat || fakeDomain || mayMoc || saiBrand || khuonSao || boiXau}) — sinh lại 1 lần`)
        candidates.splice(candidates.indexOf(cand) + 1, 0, cand)   // xét lại ngay sau bài này
        continue
      }
      if (selfName || fakeStat || fakeDomain || mayMoc || saiBrand || khuonSao || boiXau) {
        const why = selfName ? `self_nick_mention:${selfName}`
          : fakeStat ? `fabricated_stat:${fakeStat}`
          : fakeDomain ? `fabricated_domain:${fakeDomain}`
          : mayMoc ? `giong_may_moc:${mayMoc}`
          : saiBrand ? `sai_ten_thuong_hieu:${saiBrand}`
          : khuonSao ? `khuon_quang_cao_sao:${khuonSao}`
          : `quang_cao_tu_boi_xau:${boiXau}`
        stats.rejected++
        if (selfName) stats.gen_reject.self_name++
        else if (fakeStat) stats.gen_reject.fake_stat++
        else if (fakeDomain) stats.gen_reject.fake_domain++
        else if (mayMoc) stats.gen_reject.may_moc++
        else if (saiBrand) stats.gen_reject.sai_brand = (stats.gen_reject.sai_brand || 0) + 1
        else if (khuonSao) stats.gen_reject.khuon_sao = (stats.gen_reject.khuon_sao || 0) + 1
        else stats.gen_reject.boi_xau = (stats.gen_reject.boi_xau || 0) + 1
        learnFeedback(gen.text, 1, why, cand)
        actionRows.push({
          user_id: account.owner_id, session_id: sessionRow?.id, account_id,
          action_type: 'comment', target_fb_post_id: post.fbPostId, post_url: post.link,
          post_snippet: post.text.slice(0, 200), is_suggested: post.isSuggested,
          comment_text: gen.text, matched_keyword: cand.matched || null,
          status: 'skipped', skip_reason: why,
        })
        continue
      }

      // Kiểm duyệt — cổng cuối trước khi cho lên Facebook
      const verdict = await aiBrain.qualityGateComment({
        comment: gen.text,
        postText: post.text,
        group: { name: 'Bảng tin' },
        topic: commentTopic,   // ĐÚNG tier — không loại oan comment tech nữa
        nick: { username: account.username, created_at: account.created_at },
        ownerId: account.owner_id,
        brandConfig: cp.brandConfig,
        adStrategy: cp.adStrategy,   // ad chủ đích → gate cho nhắc brand 1 lần (hết bug tự huỷ ad)
      })

      const baseRow = {
        user_id: account.owner_id, session_id: sessionRow?.id, account_id,
        action_type: 'comment', target_fb_post_id: post.fbPostId,
        target_fb_user_id: post.authorFbId, post_url: post.link,
        post_snippet: post.text.slice(0, 200), is_suggested: post.isSuggested,
        matched_keyword: cand.matched || null,
        comment_text: gen.text,
        ai_moderator_verdict: verdict || null,   // JSONB — giữ nguyên object
        ad_strategy: decision.isAd ? decision.strategy : 'organic',
        matched_product: decision.product ? decision.product.name : null,
        ad_score: decision.score || null,
      }

      if (!verdict || !verdict.approved) {
        stats.rejected++; stats.gen_reject.quality_gate++
        learnFeedback(gen.text, 2, `quality_rejected:${verdict?.reason || 'no_verdict'}`, cand)  // rớt gate → điểm 2
        actionRows.push({ ...baseRow, status: 'skipped', skip_reason: `quality_gate:${verdict?.reason || 'no_verdict'}` })
        continue
      }

      // Qua gate → feedback DƯƠNG. Điểm từ điểm chất lượng của verdict (nếu có),
      // clamp 3-5 để daily-review coi đây là ví dụ tốt cần giữ/nhân bản.
      {
        const dims = [verdict.naturalness, verdict.relevance, verdict.value].filter(x => typeof x === 'number')
        const avg = dims.length ? dims.reduce((a, b) => a + b, 0) / dims.length : 8
        const passScore = Math.max(3, Math.min(5, Math.round(avg / 2)))
        learnFeedback(gen.text, passScore, 'quality_gate_passed', cand)
      }

      if (dry_run) {
        actionRows.push({ ...baseRow, status: 'skipped', skip_reason: 'dry_run' })
        stats.queued++
        if (cand.adjacent) stats.queued_near++; else { farQueued++; stats.queued_far++ }
        if (decision.isAd) { stats.ads++; adUsed++ }
        continue
      }

      // Xếp hàng job comment_post — rải ra, KHÔNG dồn cục.
      //
      // BUG CŨ: `delayMin` random LẠI mỗi vòng rồi NHÂN với chỉ số
      // (queued * delayMin) → comment #2 có thể +90 phút, #3 chỉ +90 phút
      // (2×45) → hai job TRÙNG mốc, phá vỡ chính min-gap đang viện dẫn.
      // Nay CỘNG DỒN: mỗi job cách job trước một khoảng thật sự.
      //
      // GIÃN CÁCH 12-22 PHÚT (hạ từ 45-90 ngày 27/08). Chú thích cũ viện dẫn
      // "hard-limits minGap 2700s" là SAI — HARD_LIMITS.feed_comment.minGapSeconds
      // là 480 (8 phút), chưa bao giờ là 2700. Với 45-90 phút thì 50 comment cần
      // ~56 tiếng: chỉ tiêu 50/ngày là bất khả thi về mặt số học. 12-22 phút cho
      // trung bình ~17 phút → 50 comment rải vừa khung 07:00-22:00, mà vẫn gấp
      // đôi min-gap an toàn 8 phút.
      nextCommentAt += (12 + Math.floor(Math.random() * 11)) * 60 * 1000
      const scheduledAt = new Date(nextCommentAt)

      // Quảng cáo được ƯU TIÊN (01/09): priority 35 (< 40) để khi hàng đợi ùn
      // (ít nick khỏe) poller nhặt comment quảng cáo trước comment organic.
      // is_ad/ad_strategy trong payload để job-watchdog (VPS) nhận diện và THA
      // 1 lần khi job quá hạn — dời lịch thay vì hủy (đo 27-31/08: 7 comment
      // quảng cáo chết oan vì stale_pending_timeout, ~22% số đã xếp).
      const { error: insErr } = await supabase.from('jobs').insert({
        type: 'comment_post',
        status: 'pending',
        created_by: account.owner_id,
        scheduled_at: scheduledAt.toISOString(),
        priority: decision.isAd ? 35 : 40,
        payload: {
          account_id,
          post_url: post.link,
          fb_post_id: post.fbPostId,
          comment_text: gen.text,
          source_name: 'newsfeed',
          owner_id: account.owner_id,
          is_ad: decision.isAd || false,
          ad_strategy: decision.isAd ? decision.strategy : 'organic',
        },
      })

      if (insErr) {
        actionRows.push({ ...baseRow, status: 'failed', error_message: String(insErr.message || insErr).slice(0, 200) })
        continue
      }

      actionRows.push({ ...baseRow, status: 'done' })
      stats.queued++
      if (cand.adjacent) stats.queued_near++; else { farQueued++; stats.queued_far++ }
      if (decision.isAd) { stats.ads++; adUsed++ }
      console.log(`[FEED-SEED] Xếp hàng #${stats.queued} (${decision.isAd ? '📢 ' + decision.strategy : '💬 organic'}) lúc ${scheduledAt.toLocaleTimeString('vi-VN')}: "${gen.text.slice(0, 60)}..."`)
    }

    // ── 6. Ghi log ──
    //
    // MỘT DÒNG TRÙNG TỪNG LÀM MẤT CẢ LÔ (sửa 07/09). feed_actions có unique
    // index (account_id, target_fb_post_id) cho action_type='comment'. Bài đã
    // từng xử lý mà quay lại feed (hoặc do đường săn lấy trúng) làm insert cả
    // lô fail → "Đã ghi 0/7", mất sạch nhật ký của phiên. Hậu quả không phải
    // mất comment (comment vẫn sinh + đăng bình thường) mà là MÙ QUAN TRẮC:
    // health-check, báo cáo sản lượng, mục huong_camp đều đọc bảng này nên
    // tưởng hệ thống đứng im — đúng cảm giác "sáng giờ chẳng làm gì".
    // Đo thật 07/09: 3 phiên mất trắng log (0/7, 0/5, 0/3).
    // Nay: lô hỏng thì ghi lại TỪNG DÒNG, chỉ dòng trùng bị bỏ.
    if (actionRows.length) {
      let saved = 0, trung = 0
      const laTrung = (e) => /duplicate key|unique constraint/i.test(String(e?.message || e))
      for (let i = 0; i < actionRows.length; i += 100) {
        const chunk = actionRows.slice(i, i + 100)
        let loLoi = null
        try {
          const { error } = await supabase.from('feed_actions').insert(chunk)
          if (error) loLoi = error
          else { saved += chunk.length; continue }
        } catch (e) { loLoi = e }

        // Lô hỏng → cứu từng dòng
        for (const row of chunk) {
          try {
            const { error } = await supabase.from('feed_actions').insert(row)
            if (!error) saved++
            else if (laTrung(error)) trung++
            else console.warn(`[FEED-SEED] Ghi log dòng lỗi: ${error.message || error}`)
          } catch (e) {
            if (laTrung(e)) trung++
            else console.warn(`[FEED-SEED] Ghi log dòng ném lỗi: ${e.message}`)
          }
        }
        if (!laTrung(loLoi)) console.warn(`[FEED-SEED] Lô ghi log lỗi: ${loLoi?.message || loLoi}`)
      }
      console.log(`[FEED-SEED] Đã ghi ${saved}/${actionRows.length} bản ghi${trung ? ` (${trung} bài đã comment trước đó, bỏ qua)` : ''}`)
    }

    if (sessionRow) {
      await supabase.from('feed_sessions').update({
        finished_at: new Date().toISOString(),
        posts_scanned: stats.scanned,
        posts_commented: stats.queued,
        status: 'done',
      }).eq('id', sessionRow.id)
    }

    console.log(`[FEED-SEED] Xong: quét ${stats.scanned}, ứng viên ${stats.candidates}, sinh ${stats.generated}, loại ${stats.rejected}, xếp hàng ${stats.queued} (quảng cáo ${stats.ads}/${stats.ads_attempted} cơ hội)`)
    const dropNote = Object.entries(stats.filter_drop).filter(([, n]) => n > 0).map(([k, n]) => `${k}=${n}`).join(', ')
    console.log(`[FEED-SEED] Cửa lọc: ${dropNote || 'không loại bài nào'}`)
    const genNote = Object.entries(stats.gen_reject).filter(([, n]) => n > 0).map(([k, n]) => `${k}=${n}`).join(', ')
    console.log(`[FEED-SEED] Loại khi sinh: ${genNote || 'không loại comment nào'}`)
    return {
      success: true,
      posts_scanned: stats.scanned,
      candidates: stats.candidates,
      generated: stats.generated,
      rejected: stats.rejected,
      queued: stats.queued,
      ads: stats.ads,
      ads_attempted: stats.ads_attempted,
      ads_boosted: stats.ads_boosted,
      cand_near: stats.cand_near, cand_far: stats.cand_far,
      queued_near: stats.queued_near, queued_far: stats.queued_far,
      far_capped: stats.far_capped,
      san_search: stats.san_search || null,   // đường săn bài có người hỏi (06/09)
      ai_eval_n: stats.ai_eval_n, ai_ad_n: stats.ai_ad_n, ai_verdicts: stats.ai_verdicts,
      // Quan trắc tầng AI CHỌN BÀI — thiếu mấy số này thì không phân biệt được
      // "AI chấm rồi thấy bài nào cũng đạt" với "AI không hề chạy" (bệnh 27/08).
      ai_skip_n: stats.ai_skip_n, ai_min_score: stats.ai_min_score, gen_retry: stats.gen_retry,
      ai_lo_hong: stats.ai_lo_hong, ai_lo_bo_dt: stats.ai_lo_bo_dt,
      ai_skip_ly_do: stats.ai_skip_ly_do,
      filter_drop: stats.filter_drop,
      gen_reject: stats.gen_reject,
      no_link_samples: stats.no_link_samples,
      zero_action: stats.queued === 0,
    }
  } catch (err) {
    if (sessionRow) {
      try {
        await supabase.from('feed_sessions').update({
          finished_at: new Date().toISOString(),
          posts_scanned: stats.scanned,
          posts_commented: stats.queued,
          status: String(err.message).startsWith('SKIP_') ? 'aborted' : 'failed',
          error_message: err.message.slice(0, 300),
        }).eq('id', sessionRow.id)
      } catch {}
    }
    throw err
  } finally {
    await releaseSession(account_id, supabase)
  }
}

module.exports = feedSeed
