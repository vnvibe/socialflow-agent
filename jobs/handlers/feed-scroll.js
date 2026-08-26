/**
 * feed-scroll.js — Nuôi thuật toán newsfeed.
 *
 * Cuộn feed trong một ngân sách THỜI GIAN (30-45 phút), dừng đọc 8-12s mỗi bài,
 * like các bài khớp niche. KHÔNG comment ở job này — comment thuộc feed_seed.
 *
 * Mục đích: dạy thuật toán Facebook rằng nick quan tâm ngành X, để feed dần
 * đẩy bài ngành đó lên. Đây là ĐẦU VÀO của mọi thứ còn lại — phải chạy trước
 * vài ngày thì feed_seed mới có bài đề xuất đúng ngành để bám vào.
 *
 * An toàn: mọi hành động qua hard-limits + warm-up; phát hiện chặn thì thoát ngay;
 * mọi việc đã làm đều ghi vào feed_actions để báo cáo và cho vòng tự học.
 */

const { getPage, releaseSession } = require('../../browser/session-pool')
const { humanMouseMove } = require('../../browser/human')
const { getBlockDetectionScript, reasonToStatus } = require('../../lib/block-detector')
const guard = require('../../lib/checkpoint-guard')
const { recordSignal } = require('../../lib/signal-collector')
const { checkHardLimit, applyAgeFactor, getNickAgeDays, SessionTracker } = require('../../lib/hard-limits')
const feedDom = require('../../browser/feed-dom')
const { buildExclusionContext, screenPost, isHighAffinity } = require('../../lib/feed-filter')
const R = require('../../lib/randomizer')

const FEED_URL = 'https://www.facebook.com/'

async function feedScroll(payload, supabase) {
  const {
    account_id,
    duration_minutes,      // mặc định 30-45 phút ngẫu nhiên
    dry_run = false,       // true = chỉ cuộn + ghi log, KHÔNG like
    max_likes,             // trần like RIÊNG cho phiên này (scheduler chia sẵn)
    job_id,
  } = payload || {}

  if (!account_id) throw new Error('account_id is required for feedScroll')

  // ── 1. Nick + hồ sơ ngách ──
  const { data: account } = await supabase
    .from('accounts').select('*, proxies(*)').eq('id', account_id).single()
  if (!account) throw new Error('Account not found')

  // PRE-FLIGHT CẦU DAO: nick đã bị ngắt → không mở browser like nữa.
  if (['at_risk', 'checkpoint', 'disabled', 'banned'].includes(account.status) || account.is_active === false) {
    throw new Error(`SKIP_nick_paused: ${account.status}`)
  }

  const { data: profiles } = await supabase
    .from('niche_profiles').select('*').eq('account_id', account_id).limit(1)
  const niche = (profiles && profiles[0]) || null
  if (!niche) throw new Error('SKIP_no_niche_profile')
  if (!niche.farming_enabled) throw new Error('SKIP_farming_disabled')

  const keywords = niche.target_keywords || []
  if (!keywords.length) throw new Error('SKIP_no_keywords')

  // ── 2. Hạn mức ──
  // Warm-up không chặn theo tuổi nick nữa; nick mới chỉ giảm nhẹ số like ở dưới.
  const nickAge = getNickAgeDays(account)

  const likeBudget = account.daily_budget?.feed_like || { used: 0, max: niche.daily_likes || 50 }
  const likeCheck = checkHardLimit('feed_like', likeBudget.used, 0)
  if (!likeCheck.allowed) throw new Error('SKIP_feed_like_limit_reached')

  const tracker = new SessionTracker()
  // Trần like của PHIÊN NÀY. Ưu tiên max_likes do feed-scheduler chia sẵn
  // (tổng like/ngày ÷ số phiên/ngày) — nếu lấy thẳng niche.daily_likes thì
  // phiên đầu tiên đốt sạch hạn mức ngày, các phiên sau chỉ còn nước báo
  // SKIP_feed_like_limit_reached → nick chạy dồn một cục rồi im cả ngày.
  // Nick mới: giảm nhẹ khối lượng thay vì chặn hẳn (applyAgeFactor).
  const perSessionCap = Number(max_likes) > 0 ? Number(max_likes) : (niche.daily_likes || 50)
  const maxLikes = applyAgeFactor(Math.min(likeCheck.remaining, perSessionCap), nickAge)

  // ── 3. Ngân sách thời gian ──
  const minutes = duration_minutes || (30 + Math.floor(Math.random() * 16)) // 30-45
  const deadline = Date.now() + minutes * 60 * 1000

  // ── 4. Mở phiên ──
  let sessionRow = null
  let page = null
  const stats = { scanned: 0, liked: 0, skipped: 0, niche: 0, interest: 0, general: 0, errors: [] }
  // NGOÀI try: phiên cuộn kéo 30-45 phút, page detach/timeout giữa chừng là
  // chuyện thường. Trước đây khai báo TRONG try nên catch không với tới →
  // like đã bấm thật trên Facebook nhưng không dòng log nào được ghi.
  const actionRows = []

  try {
    const sess = await getPage(account)
    page = sess.page

    // Ghi feed_sessions ngay để UI thấy phiên đang chạy.
    // PHẢI kiểm lỗi: feed_actions.session_id là NOT NULL REFERENCES feed_sessions.
    // Nuốt lỗi ở đây → sessionRow null → mọi row action có session_id undefined
    // → CẢ LÔ 100 row insert fail → mất sạch log phiên 30-45 phút.
    const { data: created, error: sessErr } = await supabase.from('feed_sessions').insert({
      user_id: account.owner_id,
      account_id,
      job_id: job_id || null,
      session_kind: 'feed_scroll',
      status: 'running',
    }).select('id')
    if (sessErr || !created?.[0]?.id) {
      throw new Error(`Không tạo được feed_session: ${sessErr?.message || 'insert không trả id'}`)
    }
    sessionRow = created[0]

    console.log(`[FEED-SCROLL] ${account.username} — ngách "${niche.niche}", ${minutes} phút, tối đa ${maxLikes} like${dry_run ? ' (CHẠY THỬ, không like)' : ''}`)

    await page.goto(FEED_URL, { waitUntil: 'domcontentloaded', timeout: 45000 })
    await R.sleepRange(4000, 7000)

    // Phát hiện chặn TRƯỚC khi làm gì → CẦU DAO (huỷ hết job chờ + thông báo)
    const blocked = await page.evaluate(getBlockDetectionScript())
    if (blocked.blocked) {
      await guard.tripBreaker(supabase, account_id, `feed_block:${blocked.reason}`, {
        jobId: job_id, ownerId: account.owner_id, recordSignal,
      })
      throw new Error(`CIRCUIT_BREAKER_TRIPPED: feed_block:${blocked.reason}`)
    }

    await humanMouseMove(page)

    // ── 5. Ngữ cảnh loại trừ: nick nhà chặn TỰ ĐỘNG ──
    const { data: ownNicks } = await supabase.from('accounts').select('fb_user_id')
    const { data: commented } = await supabase.from('feed_actions')
      .select('target_fb_post_id').eq('account_id', account_id).eq('action_type', 'comment').limit(500)
    const { data: exclusions } = await supabase.from('feed_exclusions')
      .select('*').eq('user_id', account.owner_id).eq('is_active', true)

    const exCtx = buildExclusionContext({
      ownNickFbIds: (ownNicks || []).map(x => x.fb_user_id).filter(Boolean),
      commentedPostIds: (commented || []).map(x => x.target_fb_post_id).filter(Boolean),
      exclusions: exclusions || [],
    })

    // ── 6. Cuộn + xử lý theo lô ──
    let lastLikeAt = 0

    await feedDom.scrollAndCollect(page, {
      scrolls: 200,                       // rất lớn — thực tế dừng bởi ngân sách thời gian
      dwellMs: [8000, 12000],             // dừng đọc như người thật
      refreshEveryMs: [8 * 60 * 1000, 15 * 60 * 1000],  // 8–15 phút lại tải bài mới
      msLeft: () => deadline - Date.now(),
      onRefresh: async (lan) => {
        console.log(`[FEED-SCROLL] Tải lại feed lấy bài mới (lần ${lan})`)
        await page.goto(FEED_URL, { waitUntil: 'domcontentloaded', timeout: 45000 })
        await R.sleepRange(4000, 7000)
        await humanMouseMove(page)
      },
      shouldStop: () => Date.now() > deadline || tracker.get('feed_like') >= maxLikes,
      onBatch: async (fresh) => {
        for (const post of fresh) {
          if (Date.now() > deadline) return
          stats.scanned++

          const screened = screenPost({
            fbPostId: post.fbPostId,
            authorFbId: post.authorFbId,
            authorType: post.authorType,
            text: post.text,
            isAd: post.isAd,
          }, exCtx, niche)

          if (!screened.eligible) {
            stats.skipped++
            actionRows.push({
              user_id: account.owner_id, session_id: sessionRow?.id, account_id,
              action_type: 'skip', target_fb_post_id: post.fbPostId,
              post_snippet: post.text.slice(0, 200), is_suggested: post.isSuggested,
              status: 'skipped', skip_reason: screened.reason,
            })
            continue
          }

          const tier = screened.tier             // 'niche' | 'interest' | 'general'
          const isNiche = tier === 'niche'
          const isInterest = tier === 'interest'
          if (isNiche) stats.niche++
          else if (isInterest) stats.interest++
          else stats.general++

          // Dừng đọc — thời gian dừng là TÍN HIỆU MẠNH NHẤT dạy thuật toán "nick
          // này quan tâm gì". Bài đúng ngách đọc lâu nhất, bài tech đọc vừa, bài
          // lạc đề lướt nhanh (đọc lâu bài lạc đề = dạy nhầm thuật toán).
          const dwellLo = isNiche ? 6000 : isInterest ? 5000 : 1500
          const dwellHi = isNiche ? 11000 : isInterest ? 9000 : 3500
          actionRows.push({
            user_id: account.owner_id, session_id: sessionRow?.id, account_id,
            action_type: 'dwell', target_fb_post_id: post.fbPostId,
            post_snippet: post.text.slice(0, 200), is_suggested: post.isSuggested,
            matched_keyword: screened.matched || null, status: 'done',
          })
          await R.sleepRange(dwellLo, dwellHi)

          // ── Like — HUẤN LUYỆN THUẬT TOÁN (chiến lược nhiều ngày) ──
          // Feed cá nhân nghèo bài ngách → phải nuôi tín hiệu "mê tech" để FB đẩy
          // thêm bài đúng ngách vào feed các ngày sau. Nên:
          //   niche             → luôn cân nhắc like (tín hiệu mạnh nhất)
          //   interest GẦN camp → like phần lớn (~80%) bài hạ tầng/VPS/devops →
          //                       dạy FB đẩy thêm nội dung ĐÚNG HƯỚNG CAMP (user
          //                       22/08: "tìm nhiều hơn" bài liên quan VPS)
          //   interest XA camp  → like ít hơn (~40%) bài AI-chat/content thuần →
          //                       giảm tín hiệu kéo feed lệch sang AI
          //   general           → gần như bỏ qua (~6%) — chút nhiễu cho tự nhiên.
          const adjacent = isNiche || (isInterest && isHighAffinity(screened.matched))
          const likeChance = isNiche ? 1 : isInterest ? (adjacent ? 0.8 : 0.4) : 0.06
          if (Math.random() > likeChance) continue

          const chk = tracker.check('feed_like', likeBudget.used)
          if (!chk.allowed || tracker.get('feed_like') >= maxLikes) continue

          const gap = 25000 + Math.random() * 35000   // 25-60s giữa 2 like
          const since = Date.now() - lastLikeAt
          if (lastLikeAt && since < gap) await R.sleep(gap - since)

          if (dry_run) {
            tracker.increment('feed_like')
            stats.liked++
            lastLikeAt = Date.now()
            actionRows.push({
              user_id: account.owner_id, session_id: sessionRow?.id, account_id,
              action_type: 'like', target_fb_post_id: post.fbPostId,
              post_snippet: post.text.slice(0, 200), is_suggested: post.isSuggested,
              matched_keyword: screened.matched || null, status: 'skipped', skip_reason: 'dry_run',
            })
            continue
          }

          try {
            const res = await likePost(page, post)
            if (res && res.ok) {
              tracker.increment('feed_like')
              stats.liked++
              lastLikeAt = Date.now()
              await supabase.rpc('increment_budget', { p_account_id: account_id, p_action_type: 'feed_like' })
              actionRows.push({
                user_id: account.owner_id, session_id: sessionRow?.id, account_id,
                action_type: 'like', target_fb_post_id: post.fbPostId, post_url: post.link,
                post_snippet: post.text.slice(0, 200), is_suggested: post.isSuggested,
                matched_keyword: screened.matched || null, status: 'done',
              })
            } else {
              // BUG CŨ: không có nhánh này — like hụt thì im lặng hoàn toàn,
              // job vẫn báo success với posts_liked=0 mà không ai biết vì sao.
              const reason = (res && res.reason) || 'unknown'
              actionRows.push({
                user_id: account.owner_id, session_id: sessionRow?.id, account_id,
                action_type: 'like', target_fb_post_id: post.fbPostId, post_url: post.link,
                post_snippet: post.text.slice(0, 200), is_suggested: post.isSuggested,
                matched_keyword: screened.matched || null,
                status: 'skipped', skip_reason: `like_failed:${reason}`,
              })
            }
          } catch (e) {
            stats.errors.push(e.message)
            actionRows.push({
              user_id: account.owner_id, session_id: sessionRow?.id, account_id,
              action_type: 'like', target_fb_post_id: post.fbPostId,
              status: 'failed', error_message: e.message.slice(0, 200),
            })
          }
        }
      },
    })

    // ── 7. Ghi log hành động theo lô ──
    await flushActions(supabase, actionRows)

    if (sessionRow) {
      await supabase.from('feed_sessions').update({
        finished_at: new Date().toISOString(),
        posts_scanned: stats.scanned,
        posts_liked: stats.liked,
        status: 'done',
      }).eq('id', sessionRow.id)
    }

    console.log(`[FEED-SCROLL] Xong: quét ${stats.scanned} (ngành ${stats.niche}, tech ${stats.interest}, chung ${stats.general}), like ${stats.liked}, bỏ qua ${stats.skipped}`)
    return {
      success: true,
      posts_scanned: stats.scanned,
      posts_liked: stats.liked,
      skipped: stats.skipped,
      niche_posts: stats.niche,
      interest_posts: stats.interest,
      general_posts: stats.general,
      actual_likes: stats.liked,
      zero_action: stats.liked === 0,
    }
  } catch (err) {
    if (sessionRow) {
      try {
        await supabase.from('feed_sessions').update({
          finished_at: new Date().toISOString(),
          posts_scanned: stats.scanned,
          posts_liked: stats.liked,
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

/**
 * Bấm nút Thích của đúng bài (tìm lại theo fb_post_id đã trích).
 * Trả false nếu không tìm thấy nút — KHÔNG ném lỗi để không làm hỏng cả phiên.
 */
// Ghi log hành động theo lô. Tách riêng để gọi được ở CẢ đường thành công lẫn
// đường lỗi — phiên 30-45 phút mà exception giữa chừng thì like đã bấm thật
// nhưng log biến mất, báo cáo sai và vòng tự học mất dữ liệu.
// KHÔNG dùng `.catch?.()`: QueryBuilder không có method .catch nên `?.()` trả
// undefined và truy vấn KHÔNG BAO GIỜ CHẠY (log biến mất âm thầm).
async function flushActions(supabase, actionRows) {
  if (!actionRows.length) return
  let saved = 0
  for (let i = 0; i < actionRows.length; i += 100) {
    const chunk = actionRows.slice(i, i + 100)
    try {
      const { error } = await supabase.from('feed_actions').insert(chunk)
      if (error) console.warn(`[FEED-SCROLL] Ghi feed_actions lỗi: ${error.message || error}`)
      else saved += chunk.length
    } catch (e) {
      console.warn(`[FEED-SCROLL] Ghi feed_actions ném lỗi: ${e.message}`)
    }
  }
  console.log(`[FEED-SCROLL] Đã ghi ${saved}/${actionRows.length} bản ghi hành động`)
  actionRows.length = 0   // tránh ghi trùng nếu được gọi lại ở catch
}

// Định vị bài theo VỊ TRÍ (aria-posinset) + XÁC MINH DANH TÍNH trước khi bấm.
//
// BUG CŨ 1: hàm này tự trích id bằng bộ selector/regex KHÁC feed-dom.js —
// thiếu a[href*="/videos/"] và permalink, regex thiếu nhóm /videos/.
// Nặng hơn: bài KHÔNG có permalink được feed-dom gán id tổng hợp 'syn_xxx'
// (rất nhiều bài như vậy), mà hàm này chỉ trích id từ link nên KHÔNG BAO GIỜ
// sinh ra 'syn_' → id !== pid → luôn trả false. Hệ quả thực đo được: 1 like
// trên 41 hành động. Dùng posinset — feed-dom đã trả sẵn.
//
// BUG CŨ 2 (vá sau): posinset KHÔNG bất biến — giữa lúc quét và lúc bấm like
// cách nhau hàng chục giây (dwell 6-11s + giãn like 25-60s), feed load tin mới
// liên tục có thể xê dịch/tái dùng vị trí → bấm nhầm bài khác. Vì vậy:
//   1. Tìm node theo posinset, XÁC MINH danh tính (permalink chứa fbPostId,
//      hoặc bài syn_ thì so 40 ký tự đầu của text).
//   2. Lệch → quét mọi div[aria-posinset] đang render tìm lại đúng bài theo id.
//   3. Không thấy ở đâu → bỏ qua (post_relocated), KHÔNG like bừa.
async function likePost(page, post) {
  return page.evaluate(({ pos, fbPostId, textHead }) => {
    const isSyn = !fbPostId || String(fbPostId).startsWith('syn_')
    const normWs = (s) => (s || '').replace(/\s+/g, ' ').trim()
    const matchesIdentity = (node) => {
      if (!isSyn) {
        const links = node.querySelectorAll('a[href]')
        for (const a of links) if (a.href.includes(fbPostId)) return true
        return false
      }
      // Bài không permalink: so text đầu (đã chuẩn hoá whitespace)
      return textHead ? normWs(node.textContent).includes(textHead) : false
    }
    const clickLike = (node) => {
      const btn = node.querySelector('[aria-label="Thích"], [aria-label="Like"]')
      if (!btn) return { ok: false, reason: 'no_like_button' }
      if (btn.getAttribute('aria-pressed') === 'true') return { ok: false, reason: 'already_liked' }
      btn.click()
      return { ok: true }
    }

    const atPos = document.querySelector(`div[aria-posinset="${pos}"]`)
    if (atPos && matchesIdentity(atPos)) return clickLike(atPos)

    // Vị trí đã xê dịch → tìm lại đúng bài trong mọi item đang render
    for (const n of document.querySelectorAll('div[aria-posinset]')) {
      if (matchesIdentity(n)) return clickLike(n)
    }

    // FALLBACK 24/08 (đo thật: 6 like mất/ngày vì post_relocated). React re-render
    // có thể BỎ attribute aria-posinset khỏi node, nên vòng trên không thấy bài dù
    // nó vẫn nằm trong DOM. Tìm lại theo DANH TÍNH rồi leo lên container gần nhất
    // chứa ĐÚNG MỘT nút Like — leo tối đa 10 cấp và chặn container ôm nhiều bài,
    // nên không thể like nhầm sang bài khác.
    const likeSel = '[aria-label="Thích"], [aria-label="Like"]'
    const climbToCard = (el) => {
      let n = el
      for (let i = 0; i < 10 && n; i++) {
        const btns = n.querySelectorAll ? n.querySelectorAll(likeSel) : []
        if (btns.length === 1) return n      // đúng 1 nút Like = đúng 1 bài
        if (btns.length > 1) return null     // đã ôm nhiều bài → dừng, không đoán
        n = n.parentElement
      }
      return null
    }
    if (!isSyn && fbPostId) {
      for (const a of document.querySelectorAll('a[href]')) {
        if (!a.href.includes(fbPostId)) continue
        const card = climbToCard(a)
        if (card) return clickLike(card)
      }
    } else if (textHead) {
      for (const btn of document.querySelectorAll(likeSel)) {
        const card = climbToCard(btn)
        if (card && normWs(card.textContent).includes(textHead)) return clickLike(card)
      }
    }
    return { ok: false, reason: atPos ? 'post_relocated' : 'post_not_in_dom' }
  }, {
    pos: post.posinset,
    fbPostId: post.fbPostId || null,
    textHead: (post.text || '').replace(/\s+/g, ' ').trim().slice(0, 40) || null,
  })
}

module.exports = feedScroll
