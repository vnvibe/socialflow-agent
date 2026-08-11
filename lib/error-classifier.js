/**
 * Classify browser/FB errors into structured types
 * Used by poller.js to save to job_failures table
 */

const ERROR_PATTERNS = [
  {
    type: 'MISSING_DATA',
    patterns: [/Missing content/i, /Missing account/i, /Missing group/i, /Missing page/i],
    retry: false,
    alertLevel: 'warning',
    alertMsg: (nick) => `Thieu du lieu cho nick "${nick}" — content/account/group khong ton tai`
  },
  {
    type: 'CHECKPOINT',
    patterns: [/checkpoint/i, /account.*secured/i, /verify.*identity/i, /security.*check/i],
    retry: false,
    pauseAccount: true,
    newStatus: 'checkpoint',
    alertLevel: 'urgent',
    alertMsg: (nick) => `Nick "${nick}" bi checkpoint — can xac minh thu cong`
  },
  {
    type: 'SESSION_EXPIRED',
    patterns: [/session.*expired/i, /login.*required/i, /not.*logged.*in/i, /cookie.*invalid/i, /please.*log.*in/i, /SESSION_EXPIRED/i],
    retry: false,
    pauseAccount: true,
    newStatus: 'expired',
    alertLevel: 'warning',
    alertMsg: (nick) => `Cookie nick "${nick}" het han — can cap nhat`
  },
  {
    type: 'RATE_LIMIT',
    patterns: [/rate.?limit/i, /too.*many.*requests/i, /slow.*down/i, /try.*again.*later/i, /temporarily.*blocked/i],
    retry: true,
    baseDelayMin: 60,
    alertLevel: 'warning',
    alertMsg: (nick) => `Nick "${nick}" bi rate limit — dang cho`
  },
  {
    type: 'CONTENT_BLOCKED',
    patterns: [/content.*blocked/i, /spam/i, /violat/i, /community.*standard/i, /removed.*post/i],
    retry: false,
    alertLevel: 'warning',
    alertMsg: (nick) => `Noi dung cua nick "${nick}" bi chan`
  },
  {
    type: 'CAPTCHA',
    patterns: [/captcha/i, /recaptcha/i, /human.*verification/i],
    retry: false,
    pauseAccount: true,
    newStatus: 'checkpoint',
    alertLevel: 'urgent',
    alertMsg: (nick) => `Nick "${nick}" bi yeu cau captcha`
  },
  // BROWSER_CRASH must come BEFORE ELEMENT_NOT_FOUND because Playwright launch
  // failures often include "process X not found" in browser logs which would
  // otherwise match ELEMENT_NOT_FOUND incorrectly
  {
    type: 'BROWSER_CRASH',
    patterns: [
      /launchPersistentContext/i,
      /Target.*page.*context.*browser.*closed/i,
      /Target.*closed/i,
      /browser.*has.*been.*closed/i,
      /context.*destroyed/i,
      /Protocol error/i,
      /browser.*disconnected/i,
      /crashed/i,
      /page.*has.*been.*closed/i,
      /SingletonLock/i,
      /ProcessSingleton/i,
    ],
    retry: true,
    baseDelayMin: 1,
    alertLevel: null,
    isBrowserCrash: true, // flag for poller to handle specially
  },
  {
    type: 'ELEMENT_NOT_FOUND',
    patterns: [/no.*element/i, /selector.*not/i, /composer.*not.*found/i, /element.*not.*found/i],
    retry: true,
    baseDelayMin: 5,
    alertLevel: null
  },
  {
    type: 'NAVIGATION_TIMEOUT',
    patterns: [/navigation.*timeout/i, /waiting.*selector/i, /ERR_CONNECTION/i, /^Timeout/i, /^.*Timeout \d+ms exceeded/i],
    retry: true,
    baseDelayMin: 5,
    alertLevel: null
  },
  {
    type: 'NETWORK_ERROR',
    patterns: [/ECONNREFUSED/i, /ENOTFOUND/i, /ETIMEDOUT/i, /fetch.*failed/i, /net::ERR/i, /ERR_PROXY/i],
    retry: true,
    baseDelayMin: 3,
    alertLevel: null
  },
  {
    type: 'CONNECTION_LOST',
    patterns: [/EPIPE/i, /socket.*hang.*up/i, /ECONNRESET/i, /Connection.*reset/i, /aborted/i, /disconnected/i],
    retry: true,
    baseDelayMin: 2,
    alertLevel: null
  },
  {
    type: 'DB_ERROR',
    patterns: [/postgrest/i, /JWT.*expired/i, /apikey/i, /row.*level.*security/i, /pg.*pool/i, /connection.*terminated/i],
    retry: true,
    baseDelayMin: 1,
    alertLevel: 'info'
  },
]

function classifyError(errorMessage) {
  if (!errorMessage) return { type: 'UNKNOWN', retry: true, baseDelayMin: 15, alertLevel: 'info' }

  const msg = typeof errorMessage === 'string' ? errorMessage : String(errorMessage)

  for (const config of ERROR_PATTERNS) {
    for (const pattern of config.patterns) {
      if (pattern.test(msg)) {
        return config
      }
    }
  }

  return { type: 'UNKNOWN', retry: true, baseDelayMin: 15, alertLevel: 'info' }
}

// Should the account be disabled?
function shouldDisableAccount(classified) {
  return !!classified.pauseAccount
}

// Is this error retryable?
function isRetryable(classified) {
  return !!classified.retry
}

// Calculate retry delay with exponential backoff + jitter (returns ms)
// attempt 0 → baseDelay, attempt 1 → base*3, attempt 2 → base*9
// Jitter: ±30% to avoid thundering herd
function getRetryDelayMs(classified, attempt) {
  const baseMin = classified.baseDelayMin || 5
  const baseMs = baseMin * Math.pow(3, attempt) * 60 * 1000
  const jitter = 0.7 + Math.random() * 0.6 // 0.7 - 1.3
  return Math.round(baseMs * jitter)
}

module.exports = {
  classifyError,
  shouldDisableAccount,
  isRetryable,
  getRetryDelayMs,
  ERROR_PATTERNS,
}
