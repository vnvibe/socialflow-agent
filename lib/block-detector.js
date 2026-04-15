/**
 * Block Detector — unified Facebook block/checkpoint detection
 * Used by post-utils.js, fetch-all.js, and any handler that navigates Facebook pages.
 *
 * Detects: checkpoint, session expired, disabled, locked, identity check, restricted
 */

/**
 * Detect if Facebook page shows a block/checkpoint state.
 * Runs inside page.evaluate() context.
 *
 * @returns {{ blocked: boolean, reason?: string, detail?: string }}
 */
function getBlockDetectionScript() {
  return () => {
    const text = (document.body?.innerText || '').substring(0, 3000)
    const url = window.location.href

    if (url.includes('/checkpoint/') || url.includes('/checkpoint?'))
      return { blocked: true, reason: 'checkpoint', detail: 'Facebook checkpoint detected' }

    if (url.includes('/login/') || url.includes('/login?') || url.includes('/login.php'))
      return { blocked: true, reason: 'session_expired', detail: 'Session expired, need re-login' }

    // Login popup overlay — FB shows "Xem thêm trên Facebook" / "See more on Facebook"
    // with email/password form while URL stays on the group page (no redirect to /login/)
    if (/xem thêm trên facebook|see more on facebook/i.test(text)) {
      // Confirm by checking for login form presence
      const hasLoginForm = document.querySelector('input[name="email"], input[type="email"], input[name="pass"]')
      if (hasLoginForm)
        return { blocked: true, reason: 'session_expired', detail: 'Login popup overlay detected — cookie expired' }
    }

    if (/your account has been disabled|tài khoản.{0,20}bị vô hiệu hóa/i.test(text))
      return { blocked: true, reason: 'disabled', detail: 'Account disabled' }

    if (/your account has been locked|tài khoản.{0,20}bị khóa/i.test(text))
      return { blocked: true, reason: 'locked', detail: 'Account locked' }

    if (/confirm your identity|xác nhận danh tính/i.test(text))
      return { blocked: true, reason: 'identity_check', detail: 'Identity verification required' }

    if (/you.{0,10}(?:temporarily|tạm thời).{0,20}(?:restricted|hạn chế)/i.test(text))
      return { blocked: true, reason: 'restricted', detail: 'Account temporarily restricted' }

    return { blocked: false }
  }
}

/**
 * Map block reason to account status value.
 * Unified: no more 'dead' — everything maps to 'expired' or 'checkpoint'.
 *
 * @param {string} reason - Block reason from detector
 * @returns {string} Account status to set
 */
function reasonToStatus(reason) {
  switch (reason) {
    case 'session_expired': return 'expired'
    case 'checkpoint':
    case 'locked':
    case 'identity_check':
    case 'restricted':
      return 'checkpoint'
    case 'disabled':
      return 'disabled'
    default:
      return 'checkpoint'
  }
}

module.exports = { getBlockDetectionScript, reasonToStatus }
