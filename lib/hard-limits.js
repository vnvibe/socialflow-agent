/**
 * Hard limits — CANNOT be overridden by user/campaign config
 * These protect accounts from Facebook detection
 */

const HARD_LIMITS = {
  friend_request:  { maxPerDay: 20, maxPerSession: 5,  minGapSeconds: 45  },
  join_group:      { maxPerDay: 5,  maxPerSession: 2,  minGapSeconds: 90  },  // was 3/1/120 — quá ít
  comment:         { maxPerDay: 15, maxPerSession: 3,  minGapSeconds: 90  },  // was: 30/8/10 — too aggressive, FB blocks
  like:            { maxPerDay: 80, maxPerSession: 15, minGapSeconds: 3   },  // was: 100/25/2
  post:            { maxPerDay: 5,  maxPerSession: 2,  minGapSeconds: 60  },
  scan:            { maxPerDay: 15, maxPerSession: 5,  minGapSeconds: 5   },

  // Nurture-specific — CHẬM và tự nhiên, ưu tiên an toàn over số lượng
  nurture_react:   { maxPerDay: 15, maxPerSession: 5,  minGapSeconds: 30  },  // 30s min giữa mỗi like
  nurture_comment: { maxPerDay: 3,  maxPerSession: 1,  minGapSeconds: 300 },  // 5 phút min giữa mỗi comment
  nurture_story:   { maxPerDay: 8,  maxPerSession: 3,  minGapSeconds: 10  },
}

/**
 * Apply age factor — newer accounts get lower quotas automatically
 * @param {number} count - desired count
 * @param {number} nickAgeDays - account age in days
 * @returns {number} adjusted count
 */
function applyAgeFactor(count, nickAgeDays) {
  if (nickAgeDays < 14)  return Math.max(1, Math.floor(count * 0.2))  // was 0.4 — cực kỳ bảo thủ 2 tuần đầu
  if (nickAgeDays < 30)  return Math.max(1, Math.floor(count * 0.35)) // was 0.4
  if (nickAgeDays < 90)  return Math.max(1, Math.floor(count * 0.6))  // was 0.65
  if (nickAgeDays < 180) return Math.max(1, Math.floor(count * 0.85))
  return count
}

/**
 * Check if action is within hard limits
 * @param {string} actionType - action type key
 * @param {number} usedToday - how many already used today
 * @param {number} usedThisSession - how many in current session
 * @returns {{ allowed: boolean, reason?: string, remaining: number }}
 */
function checkHardLimit(actionType, usedToday, usedThisSession = 0) {
  const limit = HARD_LIMITS[actionType]
  if (!limit) return { allowed: true, remaining: Infinity }

  if (usedToday >= limit.maxPerDay) {
    return { allowed: false, reason: `daily_limit_${actionType}`, remaining: 0 }
  }
  if (usedThisSession >= limit.maxPerSession) {
    return { allowed: false, reason: `session_limit_${actionType}`, remaining: 0 }
  }

  return {
    allowed: true,
    remaining: Math.min(limit.maxPerDay - usedToday, limit.maxPerSession - usedThisSession)
  }
}

/**
 * Get minimum gap between actions of this type (ms)
 */
function getMinGapMs(actionType) {
  const limit = HARD_LIMITS[actionType]
  return limit ? limit.minGapSeconds * 1000 : 5000
}

/**
 * SessionTracker — per-job session counter for maxPerSession enforcement
 * Each handler creates one at start, increments after each successful action
 */
class SessionTracker {
  constructor() { this.counts = {} }
  increment(actionType) { this.counts[actionType] = (this.counts[actionType] || 0) + 1 }
  get(actionType) { return this.counts[actionType] || 0 }

  /** Check if next action is within session + daily limits */
  check(actionType, usedToday = 0) {
    return checkHardLimit(actionType, usedToday + this.get(actionType), this.get(actionType))
  }
}

/**
 * Warm-up rules — blocks certain actions for young accounts
 * Returns which actions are allowed based on account age
 */
const WARMUP_PHASES = [
  // Week 1: CHỈ browse + like — hành vi cơ bản nhất, rất bảo thủ
  { maxDays: 7,   label: 'week1',  allowed: ['browse', 'like', 'nurture_react'],
    maxActions: 5 },   // was 10 — giảm 50%

  // Week 2: +comment nhẹ — bắt đầu tương tác nhưng rất ít
  { maxDays: 14,  label: 'week2',  allowed: ['browse', 'like', 'comment', 'nurture_react', 'nurture_comment', 'nurture_story'],
    maxActions: 12 },  // was 20 — giảm 40%

  // Week 3: +join group, scan — mở rộng phạm vi
  { maxDays: 21,  label: 'week3',  allowed: ['browse', 'like', 'comment', 'join_group', 'scan', 'nurture_react', 'nurture_comment', 'nurture_story'],
    maxActions: 20 },  // was 30 — giảm 33%

  // Week 4: +friend request — gần đầy đủ nhưng vẫn hạn chế
  { maxDays: 30,  label: 'week4',  allowed: ['browse', 'like', 'comment', 'join_group', 'scan', 'send_friend_request', 'nurture_react', 'nurture_comment', 'nurture_story'],
    maxActions: 30 },  // was 40 — giảm 25%
]

/**
 * Check if action is allowed for nick's age (warm-up enforcement)
 * @param {string} actionType
 * @param {number} nickAgeDays
 * @returns {{ allowed: boolean, phase?: string, reason?: string }}
 */
function checkWarmup(actionType, nickAgeDays) {
  if (nickAgeDays >= 30) return { allowed: true, phase: 'mature' }

  for (const phase of WARMUP_PHASES) {
    if (nickAgeDays <= phase.maxDays) {
      if (phase.allowed.includes(actionType)) {
        return { allowed: true, phase: phase.label }
      }
      return {
        allowed: false,
        phase: phase.label,
        reason: `warm_up_${phase.label}: ${actionType} blocked until day ${phase.maxDays + 1}`
      }
    }
  }
  return { allowed: true, phase: 'mature' }
}

/**
 * Calculate nick age in days — uses fb_created_at (real FB age) if available, fallback to created_at (system add date)
 */
function getNickAgeDays(account) {
  const ref = account.fb_created_at || account.created_at
  return Math.floor((Date.now() - new Date(ref).getTime()) / 86400000)
}

module.exports = {
  HARD_LIMITS,
  WARMUP_PHASES,
  applyAgeFactor,
  checkHardLimit,
  checkWarmup,
  getMinGapMs,
  getNickAgeDays,
  SessionTracker,
}
