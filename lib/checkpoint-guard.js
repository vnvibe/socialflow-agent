/**
 * checkpoint-guard.js — Cầu dao chống checkpoint (phòng ngừa, không chữa cháy).
 *
 * BÀI HỌC 14/08: FB checkpoint video-selfie gần như KHÔNG cứu được (cần chính
 * chủ quay video). Nên phải DỪNG nick NGAY khi thấy dấu hiệu MỀM đầu tiên
 * ("tạm thời bị chặn bình luận", captcha, redirect checkpoint), TRƯỚC khi nó
 * leo thang thành checkpoint cứng.
 *
 * Trước đây: comment-post phát hiện "temporarily blocked" → chỉ throw + retry →
 * nick vẫn active → job comment kế tiếp lại chạy → dồn tới checkpoint. Nay:
 * gặp dấu hiệu CỨNG → trip breaker → pause nick + huỷ hết job đang chờ.
 */

// Dấu hiệu CỨNG: FB đã hạn chế/nghi ngờ → dừng nick NGAY, không thử lại.
const HARD_PATTERNS = [
  /checkpoint/i,
  /temporarily blocked|tạm thời bị chặn|bạn tạm thời/i,
  /confirm your identity|xác nhận danh tính|verify your identity|xác minh danh tính/i,
  /we[' ]?ve limited|chúng tôi đã hạn chế|đã tạm khoá|account.{0,20}(restricted|disabled)/i,
  /suspicious activity|hoạt động đáng ngờ|unusual activity/i,
  /you[' ]?re temporarily restricted|bạn đang bị hạn chế/i,
]

// Dấu hiệu MỀM: có thể chỉ lỗi tạm — ghi tín hiệu, KHÔNG dừng ngay (để warning
// score tích luỹ; đủ ngưỡng thì poller tự giảm nhịp / pause).
const SOFT_PATTERNS = [
  /couldn[' ]?t post|không thể đăng|try again later|thử lại sau|something went wrong|đã xảy ra lỗi/i,
  /captcha|recaptcha|security check|kiểm tra bảo mật/i,
  /action blocked|hành động bị chặn|too fast|quá nhanh/i,
]

/**
 * Phân loại rủi ro từ URL + text trang.
 * @returns {{ level: 'hard'|'soft'|'none', reason: string }}
 */
function classifyRisk(pageText = '', url = '') {
  if (url && /\/checkpoint|\/confirmidentity|\/recover|\/disabled/i.test(url)) {
    return { level: 'hard', reason: 'checkpoint_url' }
  }
  const text = pageText || ''
  for (const p of HARD_PATTERNS) {
    const m = text.match(p)
    if (m) return { level: 'hard', reason: (m[0] || p.source).slice(0, 60) }
  }
  for (const p of SOFT_PATTERNS) {
    const m = text.match(p)
    if (m) return { level: 'soft', reason: (m[0] || p.source).slice(0, 60) }
  }
  return { level: 'none', reason: '' }
}

/**
 * TRIP CẦU DAO — dừng nick ngay lập tức khi gặp dấu hiệu cứng.
 * Fail-safe: mọi bước bọc try/catch, lỗi phụ không được che lỗi chính.
 *
 * @param {object} supabase
 * @param {string} accountId
 * @param {string} reason
 * @param {object} [opts] { jobId, ownerId, recordSignal }
 */
async function tripBreaker(supabase, accountId, reason, opts = {}) {
  if (!supabase || !accountId) return
  const tag = `circuit_breaker: ${reason}`.slice(0, 200)

  // 1. Pause nick: at_risk + is_active=false → poller bỏ qua mọi job nick này.
  //    Dùng 'at_risk' (không 'checkpoint') để cơ chế auto-recovery ở watchdog
  //    VPS sau 24h im tín hiệu tự queue check_health thử hồi phục nhẹ nhàng.
  try {
    await supabase.from('accounts')
      .update({ status: 'at_risk', is_active: false, last_error: tag })
      .eq('id', accountId)
  } catch (e) { console.warn(`[GUARD] update account failed: ${e.message}`) }

  // 2. Huỷ mọi job đang chờ/claim của nick → không mở browser thêm lần nào.
  try {
    await supabase.from('jobs')
      .update({ status: 'cancelled', error_message: tag, finished_at: new Date().toISOString() })
      .filter('payload->>account_id', 'eq', accountId)
      .in('status', ['pending', 'claimed'])
  } catch (e) { console.warn(`[GUARD] cancel jobs failed: ${e.message}`) }

  // 3. Ghi tín hiệu cứng để warning score + báo cáo phản ánh.
  try {
    if (opts.recordSignal) {
      opts.recordSignal(accountId, opts.jobId || null, 'checkpoint_risk', { reason })
    }
  } catch {}

  // 4. Thông báo cho user (nếu có owner) — để họ biết mà xử lý sớm.
  try {
    if (opts.ownerId) {
      await supabase.from('notifications').insert({
        user_id: opts.ownerId,
        type: 'checkpoint_risk',
        title: `Nick tạm dừng để tránh checkpoint`,
        body: `Phát hiện dấu hiệu FB hạn chế (${reason}). Đã dừng nick để bảo vệ. Kiểm tra thủ công trước khi bật lại.`,
        level: 'urgent',
      }).catch(() => {})
    }
  } catch {}

  console.warn(`[GUARD] ⛔ CẦU DAO NGẮT nick ${accountId.slice(0, 8)} — ${reason}. Đã pause + huỷ job chờ.`)
}

module.exports = { classifyRisk, tripBreaker, HARD_PATTERNS, SOFT_PATTERNS }
