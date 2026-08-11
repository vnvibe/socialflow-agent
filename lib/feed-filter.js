/**
 * feed-filter.js — Phễu lọc bài newsfeed (Tầng 0 + Tầng 1, pure functions).
 *
 * Tầng 0 (loại trừ cứng, miễn phí): nick nhà, đối thủ, blocklist, bài đã comment,
 *        bài của Page, bài quảng cáo, chủ đề nhạy cảm.
 * Tầng 1 (lọc thô từ khoá, miễn phí): khớp target_keywords + loại negative_keywords.
 * Tầng 2-4 (AI chấm điểm / sinh / gate) nằm ở handler — file này chỉ lo phần local.
 *
 * NGUYÊN TẮC FAIL-CLOSED: nếu không chắc → loại bài, không comment.
 */

// Bỏ dấu tiếng Việt để so khớp không phân biệt dấu.
function stripDiacritics(s) {
  return (s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd').replace(/Đ/g, 'D')
    .toLowerCase()
}

// So khớp theo RANH GIỚI TỪ, không phải chuỗi con.
//
// Dùng includes() thì mẫu ngắn phá hoại: 'rip' khớp trong script, description,
// subscription, stripe, trip — tức là bài ĐÚNG NGÀNH nhất (VPS/hosting/dev)
// bị chặn với lý do 'sensitive_topic:rip'. Đã kiểm: 3/4 bài VPS thật bị loại oan.
// Mẫu NHIỀU TỪ ('chia buồn') vẫn dùng includes vì bản thân nó đã đủ đặc trưng;
// chỉ mẫu MỘT TỪ mới cần ranh giới.
function matchesWholeWord(normText, kw) {
  if (!kw) return false
  if (kw.includes(' ')) return normText.includes(kw)   // cụm từ: an toàn với includes
  // \b không dùng được vì normText đã bỏ dấu nhưng vẫn có thể chứa ký tự lạ;
  // tự kiểm ký tự liền trước/sau không phải chữ-số.
  let from = 0
  for (;;) {
    const i = normText.indexOf(kw, from)
    if (i === -1) return false
    const before = i === 0 ? '' : normText[i - 1]
    const after = normText[i + kw.length] || ''
    const isWordChar = (ch) => ch !== '' && /[a-z0-9]/.test(ch)
    if (!isWordChar(before) && !isWordChar(after)) return true
    from = i + 1
  }
}

// Chủ đề nhạy cảm — comment quảng cáo vào là phản cảm, dễ bị report.
const SENSITIVE_PATTERNS = [
  // Tang lễ / mất mát
  'chia buồn', 'phân ưu', 'tang lễ', 'đám tang', 'rip', 'an nghỉ', 'mất rồi',
  'tai nạn', 'tử vong', 'qua đời', 'cầu nguyện', 'cầu siêu', 'an táng',
  'hy sinh', 'liệt sĩ', 'mộ phần', 'thi thể', 'nạn nhân',
  // Tội phạm / bạo lực — người viết hay VIẾT LIỀN để né bộ lọc của Facebook,
  // nên phải bắt cả biến thể không dấu cách (quan sát thấy 'baohanh' trên feed thật)
  'bạo hành', 'baohanh', 'hành hạ', 'đánh đập', 'giết', 'sát hại', 'án mạng',
  'hiếp dâm', 'xâm hại', 'bắt cóc', 'lừa đảo', 'tạm giữ', 'khởi tố', 'bắt giam',
  'công an', 'lấy lời khai', 'truy nã',
  // Sức khoẻ / chính trị / tôn giáo
  'chính trị', 'biểu tình', 'tôn giáo', 'ung thư', 'bệnh hiểm nghèo',
  'cấp cứu', 'hôn mê', 'ngộ độc', 'dịch bệnh',
  // Kêu gọi từ thiện — comment vào dễ bị hiểu là lợi dụng
  'kêu gọi ủng hộ', 'quyên góp', 'hoàn cảnh khó khăn',
].map(stripDiacritics)

/**
 * Dựng context loại trừ 1 lần đầu phiên (để tra nhanh trong vòng lặp).
 * @param {object} p
 *   ownNickFbIds:     string[]  — TẤT CẢ fb_user_id nick trong hệ thống (chặn comment chéo)
 *   commentedPostIds: string[]  — post đã comment (từ feed_actions)
 *   exclusions:       [{exclude_type, value, is_active}]  — bảng feed_exclusions
 */
function buildExclusionContext({ ownNickFbIds = [], commentedPostIds = [], exclusions = [] } = {}) {
  const ctx = {
    ownNicks: new Set(ownNickFbIds.filter(Boolean).map(String)),
    commented: new Set(commentedPostIds.filter(Boolean).map(String)),
    competitorIds: new Set(),
    competitorKeywords: [],
    blockedUsers: new Set(),
    blockedTopics: [],
  }
  for (const ex of exclusions) {
    if (ex.is_active === false || !ex.value) continue
    const v = String(ex.value)
    switch (ex.exclude_type) {
      case 'competitor_page':    ctx.competitorIds.add(v); break
      case 'blocked_user':       ctx.blockedUsers.add(v); break
      case 'competitor_keyword': ctx.competitorKeywords.push(stripDiacritics(v)); break
      case 'blocked_topic':      ctx.blockedTopics.push(stripDiacritics(v)); break
    }
  }
  return ctx
}

/**
 * TẦNG 0 — loại trừ cứng. Trả { ok: true } hoặc { ok: false, reason }.
 * post shape kỳ vọng: { fbPostId, authorFbId, authorType('user'|'page'), text, isAd }
 * Fail-closed: thiếu dữ liệu định danh → loại.
 */
function passesHardExclusion(post, ctx) {
  if (!post) return { ok: false, reason: 'no_post' }
  const authorId = post.authorFbId ? String(post.authorFbId) : null
  const postId = post.fbPostId ? String(post.fbPostId) : null

  // Bài quảng cáo/sponsored
  if (post.isAd) return { ok: false, reason: 'ad_post' }

  // Bài của Page (yêu cầu: chỉ nick cá nhân)
  if (post.authorType === 'page') return { ok: false, reason: 'page_author' }

  // Nick nhà — TỰ ĐỘNG, chống lộ cụm. Đây là loại trừ quan trọng nhất.
  if (authorId && ctx.ownNicks.has(authorId)) return { ok: false, reason: 'own_nick' }

  // Đối thủ / blocklist
  if (authorId && ctx.competitorIds.has(authorId)) return { ok: false, reason: 'competitor_page' }
  if (authorId && ctx.blockedUsers.has(authorId)) return { ok: false, reason: 'blocked_user' }

  // Đã comment bài này rồi
  if (postId && ctx.commented.has(postId)) return { ok: false, reason: 'already_commented' }

  const normText = stripDiacritics(post.text)

  // Bài nhắc tên đối thủ
  for (const kw of ctx.competitorKeywords) {
    if (kw && normText.includes(kw)) return { ok: false, reason: `competitor_keyword:${kw}` }
  }

  // Chủ đề bị chặn (user tự thêm) + chủ đề nhạy cảm (mặc định)
  for (const kw of ctx.blockedTopics) {
    if (kw && matchesWholeWord(normText, kw)) return { ok: false, reason: `blocked_topic:${kw}` }
  }
  for (const kw of SENSITIVE_PATTERNS) {
    if (matchesWholeWord(normText, kw)) return { ok: false, reason: `sensitive_topic:${kw}` }
  }

  return { ok: true }
}

/**
 * TẦNG 1 — lọc thô từ khoá. Trả { ok, matched } hoặc { ok:false, reason }.
 * Bài phải khớp ≥1 target keyword VÀ không dính negative keyword.
 */
function matchKeywords(text, targetKeywords = [], negativeKeywords = []) {
  const norm = stripDiacritics(text)
  if (!norm.trim()) return { ok: false, reason: 'empty_text' }

  // Negative trước (loại nhanh)
  for (const nk of negativeKeywords) {
    const n = stripDiacritics(nk)
    if (n && norm.includes(n)) return { ok: false, reason: `negative_keyword:${nk}` }
  }

  // Phải khớp ít nhất 1 target keyword
  for (const tk of targetKeywords) {
    const t = stripDiacritics(tk)
    if (t && norm.includes(t)) return { ok: true, matched: tk }
  }
  return { ok: false, reason: 'no_keyword_match' }
}

// Widget/khối không phải bài viết thật — comment vào đây là vô nghĩa
const NOT_A_POST = [
  'nhung nguoi ban co the biet', 'people you may know',
  'trang goi y', 'nguoi lien he goi y', 'reels',
  'sinh nhat hom nay', 'ky niem cua ban',
].map(stripDiacritics)

/**
 * Bài có đáng để comment kiểu "người dùng bình thường" không?
 * Dùng cho hạng general — không cần khớp từ khoá ngành.
 */
function isCommentable(post) {
  const text = post.text || ''
  if (text.length < 40) return { ok: false, reason: 'too_short' }
  const norm = stripDiacritics(text)
  for (const w of NOT_A_POST) {
    if (norm.includes(w)) return { ok: false, reason: `not_a_post:${w}` }
  }
  // Bài chỉ toàn link/mã, không có câu chữ thật
  const wordCount = text.split(/\s+/).filter(w => w.length > 2).length
  if (wordCount < 8) return { ok: false, reason: 'not_enough_words' }
  return { ok: true }
}

/**
 * Chạy Tầng 0 + Tầng 1 cho 1 bài.
 *
 * Trả về HẠNG thay vì cho/không cho:
 *   tier 'niche'   — khớp từ khoá ngành → ưu tiên cao, ĐƯỢC PHÉP cài quảng cáo
 *   tier 'general' — không khớp nhưng vẫn là bài đáng comment → CHỈ organic
 *   eligible false — bị loại trừ cứng hoặc không phải bài viết thật
 *
 * Lý do có hạng general: nick chỉ comment vào bài đúng ngành trông như bot.
 * Người thật bình luận đủ thứ chuyện. Quảng cáo vẫn bị chặn riêng bởi
 * feed-ad-strategy nên nới ở đây KHÔNG làm tăng rủi ro spam.
 *
 * @returns { eligible, tier?, reason?, matched? }
 */
function screenPost(post, ctx, niche) {
  const hard = passesHardExclusion(post, ctx)
  if (!hard.ok) return { eligible: false, reason: hard.reason }

  const negatives = (niche && niche.negative_keywords) || []
  const norm = stripDiacritics(post.text)
  for (const nk of negatives) {
    const n = stripDiacritics(nk)
    if (n && norm.includes(n)) return { eligible: false, reason: `negative_keyword:${nk}` }
  }

  // Khớp từ khoá ngành → hạng niche
  for (const tk of (niche && niche.target_keywords) || []) {
    const t = stripDiacritics(tk)
    if (t && norm.includes(t)) return { eligible: true, tier: 'niche', matched: tk }
  }

  // Không khớp — vẫn comment được nếu là bài thật
  const c = isCommentable(post)
  if (!c.ok) return { eligible: false, reason: c.reason }
  return { eligible: true, tier: 'general' }
}

module.exports = {
  stripDiacritics,
  SENSITIVE_PATTERNS,
  buildExclusionContext,
  passesHardExclusion,
  matchKeywords,
  screenPost,
}
