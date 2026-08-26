/**
 * feed-dom.js — Đọc DOM newsfeed Facebook. Rút ra từ khảo sát thực tế trên nick thật.
 *
 * PHÁT HIỆN QUAN TRỌNG (đừng sửa nếu chưa khảo sát lại):
 *
 * 1. Facebook dùng CHUNG [role="article"] cho CẢ bài viết LẪN bình luận.
 *    Dùng selector đó làm container bài → bot sẽ đi comment vào comment người khác.
 *    → Bài viết  = div[aria-posinset]                     (mỗi feed item = 1 vị trí)
 *      Bình luận = [role="article"][aria-label]           (aria-label "Bình luận dưới tên..."
 *                                                          hoặc "Phản hồi bình luận của...")
 *
 * 2. innerText của cả feed item dính alt-text icon → ra "Facebook Facebook Facebook..."
 *    (đo được: 132 lần lặp "Facebook" trên 8 bài). KHÔNG dùng innerText cho thân bài.
 *    → Ưu tiên div[data-ad-preview="message"]; thiếu thì gom div[dir="auto"] lá.
 *
 * 3. cloneNode(true) rồi đọc innerText cũng hỏng — node tách khỏi DOM không tính
 *    layout nên trả cả text ẩn. Luôn đọc trên node SỐNG.
 */

const POST_CONTAINER = 'div[aria-posinset]'
const COMMENT_MARKER = '[role="article"][aria-label]'

/** Nhãn bài được đề xuất / tài trợ (song ngữ, nhiều biến thể) */
const SUGGESTED_RE = /được đề xuất|gợi ý cho bạn|đề xuất cho bạn|suggested for you|có thể bạn thích|dành cho bạn|people you may know|những người bạn có thể biết|trang gợi ý|có thể bạn quan tâm/i
const SPONSORED_RE = /được tài trợ|sponsored/i
/**
 * Dấu vết BẢN DỊCH TỰ ĐỘNG của Facebook.
 *
 * Vì sao phải bắt: FB tự dịch bài ngoại ngữ sang tiếng Việt ngay trên feed.
 * Thân bài đọc ra khi đó LÀ TIẾNG VIỆT → isVietnamese() cho qua → nick đi
 * comment tiếng Việt dưới bài gốc tiếng Bồ/Anh/Trung, người bản xứ đọc thấy
 * lạc quẻ (user báo 25/08 kèm ảnh chụp một bài tiếng Bồ như vậy).
 *
 * Hai trạng thái đều là bài ngoại ngữ, loại cả hai:
 *   - Chưa dịch, FB mời dịch  → "Xem bản dịch" / "See translation"
 *   - Đã dịch sẵn             → "Bản dịch do Facebook cung cấp" / "Xem bản gốc"
 */
const TRANSLATED_RE = /ẩn bản gốc|xem bản gốc|xem bản dịch|bản dịch|đã dịch|được dịch|đánh giá bản dịch|see translation|see original|translated from|translated by facebook|automatically translated|rate this translation/i

/**
 * Hàm chạy TRONG trang (page.evaluate). Trả mảng bài viết thô.
 * Viết dạng string-free function để Playwright serialize được.
 */
function _extractInPage({ postSel, commentSel, sugSrc, sponSrc, transSrc }) {
  const SUG = new RegExp(sugSrc, 'i')
  const SPON = new RegExp(sponSrc, 'i')
  const TRANS = new RegExp(transSrc, 'i')
  const inComment = (el) => !!el.closest(commentSel)
  const NOISE = /^(Facebook|Reels|Đang hoạt động|Thích|Bình luận|Chia sẻ|Trả lời|Xem thêm|See more)$/i

  const out = []
  for (const n of document.querySelectorAll(postSel)) {
    // ── Thân bài: cách A (element message chuyên dụng) ──
    let body = ''
    for (const s of ['div[data-ad-preview="message"]', 'div[data-ad-comet-preview="message"]']) {
      const e = n.querySelector(s)
      if (e && !inComment(e)) { body = (e.innerText || '').replace(/\s+/g, ' ').trim(); break }
    }
    // ── Thiếu thì cách B: gom div[dir="auto"] lá, ngoài comment ──
    if (body.length < 15) {
      const parts = []
      for (const e of n.querySelectorAll('div[dir="auto"], span[dir="auto"]')) {
        if (inComment(e)) continue
        if (e.querySelector('div[dir="auto"], span[dir="auto"]')) continue  // chỉ lấy lá
        const t = (e.innerText || '').replace(/\s+/g, ' ').trim()
        if (t.length < 3 || NOISE.test(t)) continue
        parts.push(t)
      }
      body = [...new Set(parts)].join(' ').trim()
    }
    if (body.length < 15) continue   // không có nội dung đọc được → bỏ

    // ── Tác giả ──
    let author = null, authorHref = null
    for (const el of n.querySelectorAll('h2 a[role="link"], h3 a[role="link"], h4 a[role="link"], strong a[role="link"]')) {
      if (inComment(el)) continue
      const t = (el.innerText || '').trim()
      if (t && t.length < 60 && !NOISE.test(t)) { author = t; authorHref = el.getAttribute('href'); break }
    }

    // ── Permalink. Các dạng href THẬT quan sát được trên feed:
    //    /posts/pfbid...  |  story_fbid=...  |  /photo/?fbid=123  |  /reel/123  |  /videos/123
    let link = null
    for (const s of ['a[href*="/posts/"]', 'a[href*="story_fbid"]', 'a[href*="fbid="]',
                     'a[href*="/videos/"]', 'a[href*="/reel/"]', 'a[href*="permalink"]']) {
      const e = n.querySelector(s)
      if (e && !inComment(e)) { link = e.getAttribute('href'); break }
    }

    // Bài dạng /stories/ — permalink THẬT, không phải Stories 24h.
    //
    // Khảo sát 25/08: 33% bài trên feed không moi được permalink; thu mẫu href
    // thật thì 3/6 mẫu có dạng /stories/<pageId>/<base64>/?view_single=false.
    // Giải base64 ra "S:_ISC:1357708063242052" — số đó là id bài. Không nhận
    // dạng dạng này thì mất trắng một phần ba nguồn bài của newsfeed.
    let linkKind = link ? 'permalink' : null
    if (!link) {
      const st = n.querySelector('a[href*="/stories/"]')
      if (st && !inComment(st)) { link = st.getAttribute('href'); linkKind = 'story' }
    }
    // ── fb_post_id ──
    // CHẨN ĐOÁN: bài không moi được permalink chiếm 33% số bài quét (đo 25/08).
    // Trước khi đoán thêm selector, thu mẫu href THẬT của chính những bài đó.
    let hrefSample = null
    if (!link) {
      const hs = []
      for (const a of n.querySelectorAll('a[href]')) {
        if (inComment(a)) continue
        const h = a.getAttribute('href') || ''
        if (!h || h === '#' || h.startsWith('javascript:')) continue
        hs.push(h.slice(0, 90))
        if (hs.length >= 4) break
      }
      hrefSample = hs
    }
    let fbPostId = null
    if (link) {
      const m = link.match(/\/posts\/([^/?#]+)|story_fbid=([^&]+)|[?&]fbid=(\d+)|\/videos\/(\d+)|\/reel\/(\d+)/)
      if (m) fbPostId = m[1] || m[2] || m[3] || m[4] || m[5]
    }
    // /stories/<pageId>/<base64>: base64 giải ra "S:_ISC:<postId>".
    if (!fbPostId && linkKind === 'story') {
      const m = link.match(/\/stories\/\d+\/([A-Za-z0-9+/=_-]+)/)
      if (m) {
        try {
          const raw = atob(m[1].replace(/-/g, '+').replace(/_/g, '/'))
          const mm = raw.match(/(\d{8,})/)
          if (mm) fbPostId = mm[1]
        } catch (e) { /* base64 hỏng → để rơi xuống id tổng hợp bên dưới */ }
      }
    }
    // Nhiều bài KHÔNG có permalink trong DOM (link thời gian chỉ render khi hover).
    // Không có id ổn định thì chống trùng sẽ hỏng → sinh id tổng hợp, tất định
    // theo tác giả + đầu nội dung (cùng bài ở phiên sau vẫn ra cùng id).
    if (!fbPostId) {
      const basis = (author || '') + '|' + body.slice(0, 120)
      let h = 0
      for (let i = 0; i < basis.length; i++) h = ((h << 5) - h + basis.charCodeAt(i)) | 0
      fbPostId = 'syn_' + Math.abs(h).toString(36)
    }

    // ── Tác giả là Page hay người dùng ──
    const authorType = (authorHref && /\/pages\//.test(authorHref)) ? 'page' : 'user'
    let authorFbId = null
    if (authorHref) {
      const m = authorHref.match(/\/profile\.php\?id=(\d+)|facebook\.com\/([A-Za-z0-9.]+)/)
      if (m) authorFbId = m[1] || m[2]
    }

    out.push({
      posinset: n.getAttribute('aria-posinset'),
      text: body.slice(0, 2000),
      author, authorHref, authorFbId, authorType,
      link, fbPostId,
      isSuggested: SUG.test(body),
      isAd: SPON.test(body),
      // Cả node (không chỉ thân bài) mới chứa nút "Xem bản dịch"/"Xem bản gốc".
      hrefSample,
      linkKind,
      isTranslated: TRANS.test(n.innerText || '') || TRANS.test(body),
      commentCount: n.querySelectorAll(commentSel).length,
      canLike: !!n.querySelector('[aria-label*="Thích"], [aria-label*="Like"]'),
      canComment: !!n.querySelector('[aria-label*="ình luận"], [aria-label*="Comment"]'),
    })
  }
  return out
}

/**
 * Đọc các bài đang hiển thị trên feed.
 * @param {import('playwright').Page} page
 * @returns {Promise<Array>} bài viết (đã lọc comment, text sạch)
 */
async function extractVisiblePosts(page) {
  return page.evaluate(_extractInPage, {
    postSel: POST_CONTAINER,
    commentSel: COMMENT_MARKER,
    sugSrc: SUGGESTED_RE.source,
    sponSrc: SPONSORED_RE.source,
    transSrc: TRANSLATED_RE.source,
  })
}

/**
 * Cuộn feed và gom bài, khử trùng lặp.
 * KHÔNG click/like/comment — chỉ cuộn và đọc.
 *
 * @param {object} opts
 *   scrolls        số lần cuộn
 *   dwellMs        [min,max] thời gian dừng đọc mỗi lần cuộn (mô phỏng người đọc)
 *   onBatch        callback(posts, i) sau mỗi lần cuộn — để handler xử lý dần
 *   shouldStop     () => bool, dừng sớm (hết ngân sách thời gian/hạn mức)
 *   refreshEveryMs [min,max] cứ sau khoảng này thì tải lại feed (xem ghi chú dưới)
 *   onRefresh      async () => {} — handler tự mở lại feed (feed-dom không biết URL)
 *   refreshGuardMs không làm mới nữa khi phiên sắp hết (mặc định 3 phút)
 *   msLeft         () => số mili giây còn lại của phiên, để áp dụng refreshGuardMs
 */
async function scrollAndCollect(page, opts = {}) {
  const scrolls = opts.scrolls || 12
  const [dMin, dMax] = opts.dwellMs || [8000, 12000]
  const seen = new Map()

  // ── Làm mới feed định kỳ ──
  // Chỉ cuộn xuống thì càng lúc càng đọc bài CŨ HƠN; bài mới đăng luôn nằm ở
  // đầu feed nên không bao giờ thấy. Với phiên 30–45 phút, quãng cuối gần như
  // lướt vùng bài cũ vô ích — trong khi bài mới mới là bài đáng comment nhất
  // (ít comment, dễ được chú ý). Người thật cũng kéo lên làm mới chứ không
  // cuộn xuống mãi. Khoảng cách ngẫu nhiên để nhịp không thành khuôn mẫu.
  const refreshRange = opts.refreshEveryMs || null
  const guardMs = opts.refreshGuardMs ?? 3 * 60 * 1000
  const pickGap = () => refreshRange[0] + Math.random() * (refreshRange[1] - refreshRange[0])
  let nextRefreshAt = refreshRange ? Date.now() + pickGap() : Infinity
  let refreshes = 0

  for (let i = 0; i < scrolls; i++) {
    if (opts.shouldStop && opts.shouldStop()) break

    const batch = await extractVisiblePosts(page)
    const fresh = []
    for (const p of batch) {
      const key = p.fbPostId || p.link || `${p.author || '?'}|${p.text.slice(0, 60)}`
      if (seen.has(key)) continue
      seen.set(key, p)
      fresh.push(p)
    }
    if (opts.onBatch && fresh.length) await opts.onBatch(fresh, i)

    // Tới hạn làm mới? Bỏ qua nếu phiên sắp hết — tải lại rồi tắt ngay thì phí.
    if (Date.now() >= nextRefreshAt && opts.onRefresh) {
      const left = opts.msLeft ? opts.msLeft() : Infinity
      if (left > guardMs) {
        refreshes++
        await opts.onRefresh(refreshes)
        // Feed tải lại → về đầu trang, bài mới nằm ở đây. `seen` giữ nguyên
        // nên bài đã xử lý không bị làm lại.
        nextRefreshAt = Date.now() + pickGap()
        continue   // vòng sau đọc ngay từ đầu feed, không cuộn qua
      }
      nextRefreshAt = Infinity   // hết giờ rồi, thôi làm mới
    }

    await page.evaluate(() => window.scrollBy(0, 900 + Math.random() * 500))
    // Dừng đọc ngẫu nhiên — vừa giống người, vừa để lazy-render kịp
    await page.waitForTimeout(dMin + Math.random() * (dMax - dMin))
  }
  return [...seen.values()]
}

module.exports = {
  POST_CONTAINER,
  COMMENT_MARKER,
  SUGGESTED_RE,
  SPONSORED_RE,
  TRANSLATED_RE,
  extractVisiblePosts,
  scrollAndCollect,
}
