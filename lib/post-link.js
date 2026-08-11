/**
 * Dựng link tới bài viết gốc — NGUỒN DUY NHẤT cho mọi nhật ký.
 *
 * Vì sao cần: nhật ký phải dẫn được về bài gốc để người đọc báo cáo kiểm chứng
 * được. Đo thực tế 10/08 trên 3 ngày dữ liệu:
 *   - react (like):  45 dòng — 0 dòng có link
 *   - read_post:      8 dòng — 1 dòng có link
 *   - comment_logs:  30 dòng — 14 dòng có link
 *
 * Cách lấy link hiện tại là quét DOM tìm thẻ <a> có href dạng permalink. Vấn đề
 * nằm ở phía Facebook: rất nhiều bài KHÔNG render permalink cho tới khi rê
 * chuột lên mốc thời gian, nên quét được hay không là hên xui.
 *
 * Ở đây xếp theo thứ tự chắc chắn giảm dần, và LUÔN nói rõ mức chính xác thay
 * vì lặng lẽ trả link nhóm rồi để người đọc tưởng đó là link bài:
 *   1. exact   — permalink thật lấy được từ DOM
 *   2. built   — tự ghép từ id bài thật (id lấy từ DOM, không phải id tổng hợp)
 *   3. context — chỉ có link nhóm/trang: đúng nơi xảy ra, KHÔNG phải bài cụ thể
 *   4. none    — không có gì
 */

// id tổng hợp do ta tự sinh để chống trùng (syn_/unknown_) KHÔNG dùng ghép URL
// được — ghép vào sẽ ra link 404, tệ hơn là không có link.
function isRealPostId(id) {
  if (!id) return false
  const s = String(id)
  if (s.startsWith('syn_') || s.startsWith('unknown_')) return false
  return /^(pfbid[\w-]+|\d{5,})$/.test(s)
}

function normalize(url) {
  if (!url) return null
  let u = String(url).split('?')[0].split('#')[0]
  if (u.startsWith('/')) u = 'https://www.facebook.com' + u
  return u.startsWith('http') ? u : null
}

/**
 * @returns {{url: string|null, accuracy: 'exact'|'built'|'context'|'none'}}
 */
function resolvePostLink({ postUrl, fbPostId, groupFbId, groupUrl, authorFbId } = {}) {
  const exact = normalize(postUrl)
  if (exact) return { url: exact, accuracy: 'exact' }

  if (isRealPostId(fbPostId)) {
    if (groupFbId) return { url: `https://www.facebook.com/groups/${groupFbId}/posts/${fbPostId}`, accuracy: 'built' }
    // Ngoài nhóm: dạng permalink dùng chung, Facebook tự điều hướng đúng bài.
    return { url: `https://www.facebook.com/${authorFbId || 'permalink'}/posts/${fbPostId}`, accuracy: 'built' }
  }

  const ctx = normalize(groupUrl) || (groupFbId ? `https://www.facebook.com/groups/${groupFbId}` : null)
  if (ctx) return { url: ctx, accuracy: 'context' }

  return { url: null, accuracy: 'none' }
}

module.exports = { resolvePostLink, isRealPostId }
