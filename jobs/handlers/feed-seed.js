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
const { decideAdStrategy, buildCommentParams } = require('../../lib/feed-ad-strategy')
const aiBrain = require('../../lib/ai-brain')
const { validateCommentNotEcho, looksLikeMetaOutput, mentionsOwnNick, fabricatesStat } = require('../../lib/ai-comment')
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

  // ?? chứ KHÔNG phải || — scheduler gửi max_comments=0 khi user cấu hình nick
  // "chỉ like, không comment". `0 || 2` biến thành 2 → nick vẫn comment đúng
  // lúc user bảo im. Chỉ khi max_comments vắng mặt (job cũ) mới về mặc định 2.
  // Nick mới: giảm nhẹ số comment mỗi phiên thay vì chặn hẳn.
  const requestedComments = max_comments ?? 2
  const limit = applyAgeFactor(Math.min(requestedComments, chk.remaining), nickAge, bypassSafety)
  if (limit <= 0) throw new Error('SKIP_no_comment_quota')

  let sessionRow = null
  const stats = { scanned: 0, candidates: 0, generated: 0, rejected: 0, queued: 0, ads: 0, ads_attempted: 0,
    // QUAN TRẮC cơ chế bám camp + AI-ad (24/08): trước đây chỉ có console.log ra
    // stdout nên KHÔNG đo được từ DB — không biết cơ chế đang quyết gì.
    cand_near: 0, cand_far: 0, queued_near: 0, queued_far: 0, far_capped: 0,
    // Đếm lý do LOẠI ở từng cửa. Không có bảng này thì chỉ thấy "46 bài → 3 ứng
    // viên" mà không biết siết ở đâu, nên mọi chỉnh ngưỡng đều là đoán mò.
    filter_drop: { no_permalink: 0, no_comment_btn: 0, fb_translated: 0, not_vietnamese: 0, tier_general: 0 },
    // Lý do loại ở tầng SINH comment (sau khi bài đã lọt mọi cửa nội dung).
    // filter_drop cho biết mất bài ở đâu; bảng này cho biết mất COMMENT ở đâu.
    gen_reject: { bad_output: 0, echo: 0, self_name: 0, fake_stat: 0, quality_gate: 0 },
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
  const deadline = Date.now() + 7 * 60 * 1000

  try {
    const sess = await getPage(account)
    const page = sess.page

    const { data: created } = await supabase.from('feed_sessions').insert({
      user_id: account.owner_id, account_id, job_id: job_id || null,
      session_kind: 'feed_seed', status: 'running',
    }).select('id')
    sessionRow = created && created[0]

    console.log(`[FEED-SEED] ${account.username} — tối đa ${limit} comment, quảng cáo đã dùng ${adCommentsToday}/${niche.daily_ad_comments ?? 2}${dry_run ? ' (CHẠY THỬ)' : ''}`)

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
    const { data: commented } = await supabase.from('feed_actions')
      .select('target_fb_post_id').eq('account_id', account_id)
      .eq('action_type', 'comment').limit(500)
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
    const candidates = []
    await feedDom.scrollAndCollect(page, {
      scrolls: 30,
      dwellMs: [4000, 7000],
      shouldStop: () => candidates.length >= limit * 6 || Date.now() > deadline,
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
          }, exCtx, niche)
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
          if (sc.tier === 'general' && niche.comment_general_posts !== true) { drop.tier_general++; continue }
          // adjacency = mức GẦN HƯỚNG CAMP. niche luôn gần; interest chỉ gần khi
          // khớp từ HIGH_AFFINITY (VPS/hạ tầng/devops). Dùng để ưu tiên chọn &
          // comment bài gần camp, bớt sa đà AI-chat thuần (user 22/08).
          const adjacent = sc.tier === 'niche' || (sc.tier === 'interest' && isHighAffinity(sc.matched))
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
    const adjacentN = candidates.filter(c => c.adjacent).length
    stats.cand_near = adjacentN
    stats.cand_far = candidates.length - adjacentN
    console.log(`[FEED-SEED] Ứng viên: ${candidates.length} (gần camp ${adjacentN}, xa ${candidates.length - adjacentN})`)

    // ── 4b. AI CHẤM AD-OPPORTUNITY theo NGỮ CẢNH (user: "để AI tự quyết bài nào
    //     có context đủ để quảng cáo, bài nào cmt bình thường"). 1 call batch cho
    //     tối đa 8 candidate đầu — evaluatePosts đọc toàn bộ nội dung, trả
    //     ad_strategy (pitch/recommend/seed/organic) + score. Kết quả đưa vào
    //     decideAdStrategy (nhánh AI-mode). AI fail → aiEvalMap rỗng → fallback
    //     keyword như cũ (fail-safe organic). ──
    const aiEvalMap = {}
    if (niche.ad_enabled && candidates.length && Date.now() < deadline) {
      try {
        const evalSet = candidates.slice(0, 8)
        const evals = await aiBrain.evaluatePosts({
          posts: evalSet.map(cd => ({ author: cd.post.author, text: cd.post.text })),
          campaign: null,
          nick: { username: account.username, account_id },
          group: { name: 'Bảng tin' },
          topic: niche.niche,
          maxPicks: evalSet.length,
          ownerId: account.owner_id,
          brandConfig: {
            brand_name: niche.brand_name,
            brand_description: niche.brand_description,
            products: niche.products || [],
          },
          groupLanguage: 'vi',
        })
        for (const ev of evals || []) {
          const cd = evalSet[ev.index - 1]
          if (cd) aiEvalMap[cd.post.fbPostId] = ev
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
    // "Lựa nhiều hơn" (user 22/08): giới hạn số comment vào bài XA CAMP (AI-chat/
    // content thuần) mỗi phiên để mix nghiêng về hướng camp. Nới khi phiên có ít
    // bài gần (tránh nick im): cho phép tối đa max(2, số bài gần) comment xa.
    const FAR_CAP = Math.max(2, adjacentN)
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
      const decision = decideAdStrategy(
        { text: post.text }, niche, { adCommentsToday: adUsed, nickAge },
        aiEvalMap[post.fbPostId] || null
      )
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

      // Sinh comment
      const gen = await aiBrain.generateSmartComment({
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

      // AI có lúc trả rác: chuỗi "empty", "null", 1-2 từ vô nghĩa. Quality gate
      // KHÔNG chặn được (nhánh too_short trả object thiếu score → lọt heuristic_pass),
      // nên phải chặn ngay tại đây. Đã quan sát thật: AI trả đúng chữ "empty".
      const badOutput = !gen || !gen.text ||
        gen.text.trim().length < 15 ||
        /^(empty|null|undefined|n\/a|none|không|khong)\.?$/i.test(gen.text.trim()) ||
        looksLikeMetaOutput(gen.text)   // model trả suy luận/meta thay vì comment (leak thật 23/06)

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
      // Không phụ thuộc model nên không thể bị chấm sót.
      const selfName = mentionsOwnNick(gen.text, account.username)
      const fakeStat = selfName ? null : fabricatesStat(gen.text, post.text)
      if (selfName || fakeStat) {
        const why = selfName ? `self_nick_mention:${selfName}` : `fabricated_stat:${fakeStat}`
        stats.rejected++
        if (selfName) stats.gen_reject.self_name++; else stats.gen_reject.fake_stat++
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
      // 45-90 phút giữa 2 comment (hard-limits feed_comment: minGap 2700s).
      //
      // BUG CŨ: `delayMin` random LẠI mỗi vòng rồi NHÂN với chỉ số
      // (queued * delayMin) → comment #2 có thể +90 phút, #3 chỉ +90 phút
      // (2×45) → hai job TRÙNG mốc, phá vỡ chính min-gap đang viện dẫn.
      // Nay CỘNG DỒN: mỗi job cách job trước 45-90 phút thật sự.
      nextCommentAt += (45 + Math.floor(Math.random() * 46)) * 60 * 1000
      const scheduledAt = new Date(nextCommentAt)

      const { error: insErr } = await supabase.from('jobs').insert({
        type: 'comment_post',
        status: 'pending',
        created_by: account.owner_id,
        scheduled_at: scheduledAt.toISOString(),
        priority: 40,
        payload: {
          account_id,
          post_url: post.link,
          fb_post_id: post.fbPostId,
          comment_text: gen.text,
          source_name: 'newsfeed',
          owner_id: account.owner_id,
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
    if (actionRows.length) {
      let saved = 0
      for (let i = 0; i < actionRows.length; i += 100) {
        const chunk = actionRows.slice(i, i + 100)
        try {
          const { error } = await supabase.from('feed_actions').insert(chunk)
          if (error) console.warn(`[FEED-SEED] Ghi log lỗi: ${error.message || error}`)
          else saved += chunk.length
        } catch (e) { console.warn(`[FEED-SEED] Ghi log ném lỗi: ${e.message}`) }
      }
      console.log(`[FEED-SEED] Đã ghi ${saved}/${actionRows.length} bản ghi`)
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
      cand_near: stats.cand_near, cand_far: stats.cand_far,
      queued_near: stats.queued_near, queued_far: stats.queued_far,
      far_capped: stats.far_capped,
      ai_eval_n: stats.ai_eval_n, ai_ad_n: stats.ai_ad_n, ai_verdicts: stats.ai_verdicts,
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
