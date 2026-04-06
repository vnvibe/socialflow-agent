/**
 * Signal Collector — Early warning system for account health
 *
 * Collects anomaly signals from handlers BEFORE Facebook formally blocks the account.
 * Risk levels determined by account_warning_scores view:
 *   - normal: 0-2 signals/24h → business as usual
 *   - watch: 3-7 signals/24h → log but continue
 *   - warning: 8+ signals/24h → reduce budget 50%
 *   - critical: 5+ signals/6h → pause nick, cancel jobs
 */

const { supabase } = require('./supabase')

// In-memory buffer to batch inserts (flush every 30s or on demand)
let signalBuffer = []
let flushTimer = null

/**
 * Record a health signal for an account
 * Buffers signals and flushes periodically to reduce DB writes
 *
 * @param {string} accountId - Account UUID
 * @param {string} jobId - Current job UUID (nullable)
 * @param {string} signalType - One of: slow_load, hidden_action, instant_decline, pending_loop, captcha_hint, redirect_warn
 * @param {object} detail - Additional context { url, duration_ms, error_hint, ... }
 */
function recordSignal(accountId, jobId, signalType, detail = {}) {
  if (!accountId || !signalType) return

  signalBuffer.push({
    account_id: accountId,
    job_id: jobId || null,
    signal_type: signalType,
    signal_detail: detail,
    detected_at: new Date().toISOString(),
  })

  console.log(`[SIGNAL] ${signalType} for ${accountId.slice(0, 8)} — ${JSON.stringify(detail).substring(0, 100)}`)

  // Auto-flush when buffer reaches 10 entries
  if (signalBuffer.length >= 10) {
    flushSignals()
  }

  // Start periodic flush timer if not running
  if (!flushTimer) {
    flushTimer = setInterval(flushSignals, 30000)
  }
}

/**
 * Flush buffered signals to DB
 */
async function flushSignals() {
  if (signalBuffer.length === 0) return

  const batch = signalBuffer.splice(0)
  try {
    const { error } = await supabase.from('account_health_signals').insert(batch)
    if (error) {
      console.error(`[SIGNAL] Flush failed (${batch.length} signals): ${error.message}`)
      // Don't re-add to buffer — signals are ephemeral, losing some is OK
    }
  } catch (err) {
    console.error(`[SIGNAL] Flush exception: ${err.message}`)
  }
}

/**
 * Get current warning score for an account
 * Used by poller before assigning jobs
 *
 * @param {string} accountId
 * @returns {{ risk_level: string, signals_6h: number, signals_24h: number, total_signals: number }}
 */
async function getWarningScore(accountId) {
  if (!accountId) return { risk_level: 'normal', signals_6h: 0, signals_24h: 0, total_signals: 0 }

  try {
    const { data, error } = await supabase
      .from('account_warning_scores')
      .select('*')
      .eq('account_id', accountId)
      .maybeSingle()

    if (error || !data) return { risk_level: 'normal', signals_6h: 0, signals_24h: 0, total_signals: 0 }
    return data
  } catch (err) {
    console.warn(`[SIGNAL] getWarningScore failed: ${err.message}`)
    return { risk_level: 'normal', signals_6h: 0, signals_24h: 0, total_signals: 0 }
  }
}

/**
 * Get warning scores for multiple accounts (batch)
 * @param {string[]} accountIds
 * @returns {Map<string, { risk_level, signals_6h, signals_24h }>}
 */
async function getWarningScores(accountIds) {
  const result = new Map()
  if (!accountIds?.length) return result

  try {
    const { data } = await supabase
      .from('account_warning_scores')
      .select('*')
      .in('account_id', accountIds)

    for (const row of (data || [])) {
      result.set(row.account_id, row)
    }
  } catch (err) {
    console.warn(`[SIGNAL] getWarningScores batch failed: ${err.message}`)
  }

  return result
}

// ─── Signal Detection Helpers (used by handlers) ───

/**
 * Check if page load was suspiciously slow
 * Call after page.goto() with timing
 */
function checkSlowLoad(accountId, jobId, url, durationMs) {
  if (durationMs > 8000) {
    recordSignal(accountId, jobId, 'slow_load', {
      url: url?.substring(0, 200),
      duration_ms: durationMs,
    })
    return true
  }
  return false
}

/**
 * Check if page redirected to checkpoint/login
 * Call after navigation to check final URL
 */
function checkRedirectWarn(accountId, jobId, expectedUrl, actualUrl) {
  if (!actualUrl) return false
  const suspicious = /\/checkpoint|\/login|\/recover|\/hacked|\/help\/contact/i.test(actualUrl)
  if (suspicious && !/\/checkpoint|\/login/.test(expectedUrl || '')) {
    recordSignal(accountId, jobId, 'redirect_warn', {
      expected: expectedUrl?.substring(0, 200),
      actual: actualUrl?.substring(0, 200),
    })
    return true
  }
  return false
}

/**
 * Check for captcha/verification hints in page content
 */
function checkCaptchaHint(accountId, jobId, pageText) {
  if (!pageText) return false
  const hints = /captcha|recaptcha|verify.*identity|xác minh.*danh tính|security check|kiểm tra bảo mật/i
  if (hints.test(pageText)) {
    recordSignal(accountId, jobId, 'captcha_hint', {
      hint: pageText.substring(0, 200),
    })
    return true
  }
  return false
}

/**
 * Record instant friend request decline (< 5 seconds)
 */
function checkInstantDecline(accountId, jobId, targetFbId, declineTimeMs) {
  if (declineTimeMs < 5000) {
    recordSignal(accountId, jobId, 'instant_decline', {
      target_fb_id: targetFbId,
      decline_time_ms: declineTimeMs,
    })
    return true
  }
  return false
}

/**
 * Record group join pending loop
 */
function checkPendingLoop(accountId, jobId, groupId, consecutivePendings) {
  if (consecutivePendings >= 3) {
    recordSignal(accountId, jobId, 'pending_loop', {
      group_id: groupId,
      consecutive: consecutivePendings,
    })
    return true
  }
  return false
}

/**
 * Record hidden action (action succeeded but result not visible)
 */
function checkHiddenAction(accountId, jobId, actionType, detail) {
  recordSignal(accountId, jobId, 'hidden_action', {
    action: actionType,
    ...detail,
  })
  return true
}

// Cleanup on process exit
function stopCollector() {
  if (flushTimer) {
    clearInterval(flushTimer)
    flushTimer = null
  }
  return flushSignals() // final flush
}

module.exports = {
  recordSignal,
  flushSignals,
  getWarningScore,
  getWarningScores,
  checkSlowLoad,
  checkRedirectWarn,
  checkCaptchaHint,
  checkInstantDecline,
  checkPendingLoop,
  checkHiddenAction,
  stopCollector,
}
