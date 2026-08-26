/**
 * Hard limits — CANNOT be overridden by user/campaign config
 * These protect accounts from Facebook detection
 */

const HARD_LIMITS = {
  friend_request:  { maxPerDay: 50,  maxPerSession: 15, minGapSeconds: 15 },
  join_group:      { maxPerDay: 20,  maxPerSession: 5,  minGapSeconds: 30 },
  comment:         { maxPerDay: 50,  maxPerSession: 10, minGapSeconds: 15 },  // Balanced & stable
  like:            { maxPerDay: 150, maxPerSession: 25, minGapSeconds: 3  },
  post:            { maxPerDay: 20,  maxPerSession: 5,  minGapSeconds: 15 },
  scan:            { maxPerDay: 50,  maxPerSession: 20, minGapSeconds: 2  },

  // Nurture-specific — ổn định, tự nhiên
  nurture_react:   { maxPerDay: 40,  maxPerSession: 12, minGapSeconds: 10 },
  nurture_comment: { maxPerDay: 25,  maxPerSession: 8,  minGapSeconds: 20 },
  nurture_story:   { maxPerDay: 30,  maxPerSession: 10, minGapSeconds: 5  },

  // Newsfeed farming — BẮT BUỘC khai báo ở đây, nếu thiếu thì checkHardLimit
  // fail-open (trả allowed:true, remaining:Infinity) và không chặn gì cả.
  feed_like:    { maxPerDay: 50, maxPerSession: 15, minGapSeconds: 25 },
  // TRẦN AN TOÀN sau sự cố checkpoint 14/08: hạ 60→25/ngày, 8→4/phiên, giãn
  // 5→8 phút. 60/ngày trên nick chưa xác minh tuổi (fb_created_at NULL) là quá
  // aggressive. 25 vẫn hơn mức cũ 8 nhưng an toàn. Nick TRƯỞNG THÀNH đã verify
  // tuổi (fb_created_at set, >30 ngày) sẽ được applyAgeFactor cho chạy đủ trần;
  // nick non/không rõ tuổi bị cắt mạnh (xem applyAgeFactor + getNickAgeDays).
  feed_comment: { maxPerDay: 25, maxPerSession: 4,  minGapSeconds: 480 },  // 8 phút giữa 2 comment
  // Trả lời reply trên comment của nick (check_replies) — hành vi tự nhiên
  // rủi ro thấp nhưng mới, trần khiêm tốn.
  reply:        { maxPerDay: 10, maxPerSession: 3,  minGapSeconds: 120 },
  feed_follow:  { maxPerDay: 6,  maxPerSession: 2,  minGapSeconds: 600 },
  feed_join:    { maxPerDay: 2,  maxPerSession: 1,  minGapSeconds: 3600 },
}

/**
 * Apply age factor — bảo vệ nick non/không rõ tuổi (sửa sau checkpoint 14/08).
 *
 * BÀI HỌC: nick fb_created_at NULL bị coi là "chạy full" → nick 5 ngày tuổi
 * comment vô tội vạ → checkpoint. Nay AN TOÀN LÀ MẶC ĐỊNH: không biết tuổi
 * = coi như non = cắt mạnh. Muốn nick cũ chạy đủ trần thì phải điền
 * fb_created_at (bằng chứng nick trưởng thành thật).
 *
 * @param {number} count
 * @param {number|null} nickAgeDays  null = KHÔNG rõ tuổi → xử lý như nick non
 * @param {boolean} bypassSafety
 * @returns {number}
 */
function applyAgeFactor(count, nickAgeDays, bypassSafety = false) {
  if (bypassSafety) return count
  // Không rõ tuổi (fb_created_at NULL) → cắt mạnh như nick <7 ngày, KHÔNG chạy full.
  if (nickAgeDays == null) return Math.max(1, Math.round(count * 0.4))
  if (nickAgeDays < 7)   return Math.max(1, Math.round(count * 0.4))
  if (nickAgeDays < 14)  return Math.max(1, Math.round(count * 0.55))
  if (nickAgeDays < 30)  return Math.max(1, Math.round(count * 0.75))
  return count
}

/**
 * Check if action is within hard limits
 * @param {string} actionType - action type key
 * @param {number} usedToday - how many already used today
 * @param {number} usedThisSession - how many in current session
 * @param {boolean} bypassSafety - if true, bypass hard limits
 * @returns {{ allowed: boolean, reason?: string, remaining: number }}
 */
function checkHardLimit(actionType, usedToday, usedThisSession = 0, bypassSafety = false) {
  if (bypassSafety) {
    return { allowed: true, remaining: 999 }
  }
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
 * Warm-up phases — GIỮ LẠI CHỈ ĐỂ THAM CHIẾU/NHÃN.
 *
 * Không còn dùng để CHẶN hành động. Quyết định vận hành: nick chạy liên tục theo
 * KPI bất kể tuổi; nick mới chỉ giảm nhẹ khối lượng qua applyAgeFactor + trọng số
 * KPI phía server. Trần an toàn thật sự nằm ở HARD_LIMITS (số lần/ngày, /phiên,
 * khoảng cách tối thiểu) — áp cho mọi nick, không phân biệt tuổi.
 */
const WARMUP_PHASES = [
  // Week 1: CHỈ browse + like — hành vi cơ bản nhất, rất bảo thủ
  { maxDays: 7,   label: 'week1',  allowed: ['browse', 'like', 'nurture_react', 'feed_like'],
    maxActions: 5 },   // was 10 — giảm 50%

  // Week 2: +comment nhẹ — bắt đầu tương tác nhưng rất ít
  { maxDays: 14,  label: 'week2',  allowed: ['browse', 'like', 'comment', 'nurture_react', 'nurture_comment', 'nurture_story', 'feed_like', 'feed_comment'],
    maxActions: 12 },  // was 20 — giảm 40%

  // Week 3: +join group, scan — mở rộng phạm vi
  { maxDays: 21,  label: 'week3',  allowed: ['browse', 'like', 'comment', 'join_group', 'scan', 'nurture_react', 'nurture_comment', 'nurture_story', 'feed_like', 'feed_comment', 'feed_follow'],
    maxActions: 20 },  // was 30 — giảm 33%

  // Week 4: +friend request — gần đầy đủ nhưng vẫn hạn chế
  { maxDays: 30,  label: 'week4',  allowed: ['browse', 'like', 'comment', 'join_group', 'scan', 'send_friend_request', 'nurture_react', 'nurture_comment', 'nurture_story', 'feed_like', 'feed_comment', 'feed_follow', 'feed_join'],
    maxActions: 30 },  // was 40 — giảm 25%
]

/**
 * Check if action is allowed for nick's age (warm-up enforcement)
 * @param {string} actionType
 * @param {number} nickAgeDays
 * @returns {{ allowed: boolean, phase?: string, reason?: string }}
 */
function checkWarmup(actionType, nickAgeDays, bypassSafety = false) {
  // LUÔN cho phép. Warm-up không còn chặn hành động theo tuổi nick — nick chạy
  // liên tục theo KPI, khối lượng do applyAgeFactor + HARD_LIMITS điều tiết.
  // Vẫn trả `phase` để log/thống kê biết nick đang ở giai đoạn nào.
  if (bypassSafety || nickAgeDays == null || nickAgeDays >= 30) {
    return { allowed: true, phase: 'mature' }
  }
  const phase = WARMUP_PHASES.find(p => nickAgeDays <= p.maxDays)
  return { allowed: true, phase: phase ? phase.label : 'mature' }
}

// Nick đã cảnh báo thiếu fb_created_at — chỉ log 1 lần/nick, tránh spam log.
const _missingAgeWarned = new Set()

/**
 * Tuổi nick (ngày) tính từ fb_created_at — tuổi tài khoản Facebook thật.
 *
 * KHÔNG fallback sang created_at (ngày thêm nick vào hệ thống): nick Facebook lâu
 * năm vừa import cookie sẽ bị tính vài ngày tuổi và bị giảm nhịp oan.
 *
 * Không biết tuổi → trả null = "KHÔNG RÕ". applyAgeFactor xử lý null như nick
 * NON (cắt mạnh) — an toàn là mặc định sau sự cố checkpoint 14/08. Muốn nick cũ
 * chạy đủ trần thì phải điền fb_created_at để chứng minh nick trưởng thành.
 * @returns {number|null} số ngày, hoặc null khi không xác định được
 */
function getNickAgeDays(account) {
  const ref = account.fb_created_at
  if (!ref) {
    const key = account.id || account.username
    if (key && !_missingAgeWarned.has(key)) {
      _missingAgeWarned.add(key)
      console.warn(`[LIMITS] Nick ${account.username || key} thiếu fb_created_at — coi như nick NON (cắt nhịp an toàn). Điền fb_created_at để nick trưởng thành chạy đủ trần.`)
    }
    return null
  }
  const ts = new Date(ref).getTime()
  if (!Number.isFinite(ts)) {
    console.warn(`[LIMITS] Nick ${account.username || account.id} có fb_created_at không hợp lệ (${ref}) — chạy full nhịp.`)
    return null
  }
  return Math.floor((Date.now() - ts) / 86400000)
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
