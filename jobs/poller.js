const { db, supabase } = require('../lib/db')
const { getApiClient } = require('../lib/api-client')
const handlers = require('./handlers')
const os = require('os')
const { closeAll } = require('../browser/session-pool')
const { classifyError, shouldDisableAccount, isRetryable, getRetryDelayMs } = require('../lib/error-classifier')
const { postCooldown } = require('../lib/randomizer')
const { getMinGapMs } = require('../lib/hard-limits')

// Use REST API for job lifecycle when AGENT_SECRET / AGENT_SECRET_KEY is available.
// config.js (embedded in exe) uses AGENT_SECRET_KEY â€” check both.
let _pollerCfg = {}
try { _pollerCfg = require('../lib/config') } catch {}
const useApi = () => !!(process.env.AGENT_SECRET || process.env.AGENT_SECRET_KEY || _pollerCfg.AGENT_SECRET_KEY)
const api = getApiClient()

// DÃ¹ng chung nguá»“n vá»›i heartbeat. TrÆ°á»›c Ä‘Ã¢y nÆ¡i nÃ y tá»± tÃ­nh `hostname-pid`,
// khÃ¡c giÃ¡ trá»‹ heartbeat khai bÃ¡o â†’ server khÃ´ng khá»›p Ä‘Æ°á»£c mÃ¡y vá»›i job, vÃ 
// cÃ¢u cá»©u job káº¹t lÃºc khá»Ÿi Ä‘á»™ng (lá»c theo agent_id) khÃ´ng bao giá» khá»›p láº§n
// cháº¡y trÆ°á»›c vÃ¬ pid Ä‘Ã£ Ä‘á»•i.
const AGENT_ID = require('../lib/agent-id').getAgentId()
const AGENT_USER_ID = process.env.AGENT_USER_ID || null  // set when user logs in via Electron
const POLL_MS = process.env.DATABASE_URL ? 5000 : 15000 // Self-hosted: 5s (no Realtime), Cloud: 15s (Realtime handles instant)
const MEM_PER_NICK_MB = 350 // ~350MB per Chromium instance
const MIN_CONCURRENT = 1
const MAX_CONCURRENT_CAP = parseInt(process.env.MAX_CONCURRENT) || 3 // 2â†’3: 6 nicks / 3 = 2 batches, saves ~30% time

function calcMaxConcurrent() {
  const override = parseInt(process.env.MAX_CONCURRENT)
  if (override > 0) return override // manual override via env

  const totalMB = os.totalmem() / (1024 * 1024)
  const freeMB = os.freemem() / (1024 * 1024)
  // Use 60% of free RAM for browser instances
  const available = freeMB * 0.6
  const calculated = Math.floor(available / MEM_PER_NICK_MB)
  return Math.max(MIN_CONCURRENT, Math.min(calculated, MAX_CONCURRENT_CAP))
}

const { checkAndBoostKPI } = require('../lib/kpi-booster')
let MAX_CONCURRENT = calcMaxConcurrent()

// Re-calculate every 2 minutes (RAM changes as browsers open/close)
setInterval(() => {
  const prev = MAX_CONCURRENT
  MAX_CONCURRENT = calcMaxConcurrent()
  if (MAX_CONCURRENT !== prev) {
    console.log(`[POLLER] Auto-scale: ${prev} â†’ ${MAX_CONCURRENT} concurrent nicks (${Math.round(os.freemem() / 1024 / 1024)}MB free)`)
  }
}, 120000)

// â”€â”€ Task Release Manager: Auto-clean stuck running/claimed (>10m) & stale pending (>4h) jobs â”€â”€
async function cleanStuckAndPendingJobs() {
  try {
    const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString()

    // 1. Release stuck RUNNING/CLAIMED jobs — THEO NHỊP TIM, không theo started_at
    // (04/09). Trước đây lọc started_at<10' nhưng bug server reset started_at
    // mỗi heartbeat nên điều kiện không bao giờ khớp — phiên dài 30-45' sống
    // ĐƯỢC là nhờ bug đó. Server vừa sửa started_at ghi 1 lần → giữ lọc cũ là
    // chém oan mọi phiên feed dài ở phút 10. Job còn heartbeat = còn sống;
    // "stuck" nghĩa là TIM NGỪNG >10' (hoặc chưa từng đập và started >10').
    const { data: runningJobs } = await supabase
      .from('jobs')
      .select('id, type, status, started_at, last_heartbeat_at')
      .in('status', ['running', 'claimed'])
      .lt('started_at', tenMinAgo)

    const cutoff = Date.now() - 10 * 60 * 1000
    const stuckRunning = (runningJobs || []).filter(j => {
      const beat = j.last_heartbeat_at || j.started_at
      return beat && new Date(beat).getTime() < cutoff
    })

    if (stuckRunning?.length > 0) {
      console.warn(`[TASK-CLEANUP] Auto-releasing ${stuckRunning.length} stuck RUNNING/CLAIMED jobs (heartbeat lặng >10m)...`)
      for (const j of stuckRunning) {
        await supabase.from('jobs').update({
          status: 'cancelled',
          error_message: 'Auto-released by task manager: execution exceeded 10m timeout.',
          finished_at: new Date().toISOString()
        }).eq('id', j.id)
      }
    }

    // 2. Clear stale PENDING jobs (>4h backlog timeout) â€” EXEMPT kpi_boost & force_now jobs
    // Was 1h â€” too aggressive: KPI boost jobs queued while agent was offline got cancelled
    // before they had a chance to run. Now 4h gives the agent time to pick them up.
    const fourHoursAgo = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString()
    const { data: stalePending } = await supabase
      .from('jobs')
      .select('id, type, payload')
      .eq('status', 'pending')
      .lt('scheduled_at', fourHoursAgo)

    if (stalePending?.length > 0) {
      // Skip KPI boost and force_now jobs â€” they should always run regardless of age.
      // Comment quáº£ng cÃ¡o (is_ad) cÅ©ng Ä‘Æ°á»£c tha á»Ÿ Ä‘Ã¢y â€” vÃ²ng poll chÃ­nh sáº½ dá»n
      // chÃºng á»Ÿ ngÆ°á»¡ng 12h náº¿u váº«n khÃ´ng nick nÃ o nháº­n (xem STALE_THRESHOLD_MS).
      const jobsToCancel = stalePending.filter(j => {
        const p = j.payload || {}
        return p.kpi_boost !== true && p.force_now !== true && p.is_ad !== true
      })
      if (jobsToCancel.length > 0) {
        console.warn(`[TASK-CLEANUP] Auto-clearing ${jobsToCancel.length} stale PENDING jobs (>4h backlog, non-KPI)...`)
        for (const j of jobsToCancel) {
          await supabase.from('jobs').update({
            status: 'cancelled',
            error_message: 'Auto-cancelled by task manager: pending backlog exceeded 4h timeout.',
            finished_at: new Date().toISOString()
          }).eq('id', j.id)
        }
      }
      const kpiSkipped = stalePending.length - jobsToCancel.length
      if (kpiSkipped > 0) {
        console.log(`[TASK-CLEANUP] Kept ${kpiSkipped} stale KPI boost job(s) alive â€” will be picked up by poller.`)
      }
    }

    // 3. Delete stale post reservations (>15m)
    const fifteenMinAgo = new Date(Date.now() - 15 * 60 * 1000).toISOString()
    await supabase.from('post_interaction_reservations')
      .delete()
      .lt('reserved_until', fifteenMinAgo)
      .eq('status', 'reserved')
  } catch (err) {
    console.warn(`[TASK-CLEANUP] Cleanup error: ${err.message}`)
  }
}

// â”€â”€ KPI Booster: Auto-check and boost unmet KPIs on startup + every 15 min â”€â”€
const triggerKpiBoostSafe = () => {
  cleanStuckAndPendingJobs()
  checkAndBoostKPI(supabase, { forceNow: true }).catch(err => {
    console.warn(`[POLLER-KPI-BOOSTER] Boost error: ${err.message}`)
  })
}

// 100% AUTOMATED: Fire IMMEDIATELY on poller startup so user never runs CLI scripts manually
triggerKpiBoostSafe()

// Repeat every 3 minutes in background loop to ensure campaign KPIs are continuously fulfilled
setInterval(triggerKpiBoostSafe, 3 * 60 * 1000)
// Task cleanup runs every 2 minutes (down from 5m) for fast stuck task release
setInterval(cleanStuckAndPendingJobs, 2 * 60 * 1000)

const POST_TYPES = handlers.getPostTypes()

// Job types that DON'T need a browser session â€” only HTTP/DB calls.
// These are the only jobs that can run alongside browser jobs without contention.
// All other "utility" jobs (fetch_*, check_*, scan_*) actually use browser, so they
// compete for the single browser slot like interaction jobs.
const BROWSER_FREE_TYPES = handlers.getBrowserFreeTypes()
// Phase 11 fix: utility/system jobs bypass active_hours + warmup + KPI gates.
// These are background tasks that must run 24/7 regardless of nick "work hours".
// User-facing actions (campaign_nurture, friend_request, post, interact_profile,
// discover_groups) are NOT in this list and remain subject to active_hours.
const UTILITY_TYPES = handlers.getUtilityTypes()


// â”€â”€â”€ NickPool â€” tracks browser-using and HTTP-only jobs â”€â”€â”€
// All jobs that use a browser go into `interactionNicks` and count toward MAX_CONCURRENT.
// Only BROWSER_FREE_TYPES (e.g. post_page_graph via Graph API) go into `httpOnlyNicks`
// and run alongside browser jobs without contention.
class NickPool {
  constructor() {
    this.interactionNicks = new Set()  // account_ids using browser
    this.httpOnlyNicks = new Set()     // account_ids running browser-free jobs (HTTP only)
    this.runningJobs = new Map()       // job_id â†’ { accId, jobType }
    this.jobsToday = 0
    this.jobsFailed = 0
  }
  // Browser-using nicks count toward concurrent limit
  isBusy()         { return this.interactionNicks.size >= MAX_CONCURRENT }
  // Same name kept for backward compat
  isRunningInteraction(accId) { return this.interactionNicks.has(accId) }
  // Nick is busy if doing ANY work
  isRunning(accId) { return this.interactionNicks.has(accId) || this.httpOnlyNicks.has(accId) }
  // Check if a specific account_id has any running job (used by session-pool to prevent eviction)
  hasRunningJob(accId) {
    for (const info of this.runningJobs.values()) {
      if (info.accId === accId) return true
    }
    return false
  }
  acquire(accId, jobId, jobType) {
    if (BROWSER_FREE_TYPES.includes(jobType)) {
      this.httpOnlyNicks.add(accId)
    } else {
      this.interactionNicks.add(accId)
    }
    this.runningJobs.set(jobId, { accId, jobType })
  }
  release(accId, jobId) {
    this.interactionNicks.delete(accId)
    this.httpOnlyNicks.delete(accId)
    this.runningJobs.delete(jobId)
    this.jobsToday++
  }
  fail(accId, jobId) {
    this.interactionNicks.delete(accId)
    this.httpOnlyNicks.delete(accId)
    this.runningJobs.delete(jobId)
    this.jobsFailed++
  }
  get size() { return this.interactionNicks.size + this.httpOnlyNicks.size }
  // Legacy alias for old code that read .utilityNicks
  get utilityNicks() { return this.httpOnlyNicks }
}
const pool = new NickPool()
// Export for session-pool to query running jobs (prevent evict-while-busy bug)
if (typeof globalThis !== 'undefined') {
  globalThis.__socialflowNickPool = pool
}

// â”€â”€â”€ Per-nick isolation tracking â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const nickCooldowns = new Map()        // account_id â†’ { lastPostAt, cooldownMs }
const nickBudgetCache = new Map()      // account_id â†’ { budget, fetchedAt }
const nickActionTimestamps = new Map()
const consecutiveSkips = new Map()     // `campaignId_roleId` â†’ skip count (reset on success) // `${accId}:${actionType}` â†’ lastActionAt
const nickHourlyActions = new Map()    // account_id â†’ { count, resetAt }
const accountStatusCache = new Map()   // account_id â†’ { is_active, status, fetchedAt }
const nickSessionStart = new Map()     // account_id â†’ timestamp when session started
const nickRestUntil = new Map()        // account_id â†’ { until, durationMin }
const nickLastClaimAt = new Map()      // account_id â†’ ts láº§n cuá»‘i Ä‘Æ°á»£c cáº§m job (fair-pick chá»‘ng starvation)
const nickBudgetExhaustedLog = new Set() // "budget_log:{accId}:{actionType}" â€” suppress spam logs
// Phase 16: group visit isolation â€” max 2 different nicks visiting same group in 30min
const groupVisitLog = new Map()        // fb_group_id â†’ [{ nickId, ts }]
const campaignStatusCache = new Map()   // campaign_id â†’ { status, fetchedAt }
const BUDGET_CACHE_TTL = 300000         // 5 min (was 1 min, VPS calls optimized)
const STATUS_CACHE_TTL = 10000         // 10s (was 5 min) for fast agent_enabled updates
const MAX_HOURLY_ACTIONS = 50          // cumulative across all types
// Randomized ranges â€” avoid fixed patterns that FB can detect
const randBetween = (min, max) => Math.floor(min + Math.random() * (max - min))
const randSessionMax = () => randBetween(25, 45) * 60 * 1000   // 25-45 min
// Rest range tuned for 3-5 active nicks: 20-45 min keeps natural rotation
// (while nick A rests, B+C work). Was 45-120 min â€” too long with few nicks,
// caused all-nicks-resting deadlock and 0 throughput. Still humanized, just
// not aggressive on a small pool.
const randRestMs = () => randBetween(20, 45) * 60 * 1000        // 20-45 min

const JOB_ACTION_MAP = {
  post_page: 'post', post_page_graph: 'post', post_group: 'post', post_profile: 'post',
  campaign_post: 'post', campaign_nurture: 'comment', campaign_discover_groups: 'join_group',
  campaign_send_friend_request: 'friend_request', campaign_interact_profile: 'like',
  campaign_scan_members: 'scan', campaign_group_monitor: 'scan',
  campaign_opportunity_react: 'comment', comment_post: 'comment',
  nurture_feed: 'nurture_react',
  // Thiáº¿u dÃ²ng nÃ y thÃ¬ poller bá» qua min-gap + warm-up gate cho job feed
  feed_scroll: 'feed_like',
  feed_seed: 'feed_comment',
  check_replies: 'reply',
}

let pollFails = 0
let poller_idleAssignWarned = false

// Cache user preferences to avoid querying on every poll
let preferenceCache = { data: [], fetchedAt: 0 }
const PREF_CACHE_TTL = 30000 // 30s

async function getExcludedUserIds() {
  const now = Date.now()
  if (now - preferenceCache.fetchedAt < PREF_CACHE_TTL) return preferenceCache.data

  // Users who have a preferred_executor_id that is NOT this agent â†’ exclude them
  const { data: profiles } = await supabase
    .from('profiles')
    .select('id, preferred_executor_id')
    .not('preferred_executor_id', 'is', null)
    .neq('preferred_executor_id', AGENT_ID)

  preferenceCache = { data: (profiles || []).map(p => p.id), fetchedAt: now }
  return preferenceCache.data
}

async function checkCampaignActive(campaignId) {
  const now = Date.now()
  const cached = campaignStatusCache.get(campaignId)
  if (cached && (now - cached.fetchedAt < STATUS_CACHE_TTL)) {
    return ['active', 'running'].includes(cached.status)
  }
  try {
    const { data } = await supabase.from('campaigns')
      .select('status')
      .eq('id', campaignId)
      .single()
    const status = data?.status || 'inactive'
    campaignStatusCache.set(campaignId, { status, fetchedAt: now })
    return ['active', 'running'].includes(status)
  } catch (err) {
    return true
  }
}

let _polling = false
let _lastPollAt = 0
let _consecutiveEmptyPolls = 0
let _pollTimeout = null

let _pollCount = 0
async function poll() {
  if (_polling) return false  // prevent concurrent polls (realtime + interval race)
  if (pool.isBusy()) return false  // all interaction slots taken

  _polling = true
  _lastPollAt = Date.now()
  _pollCount++
  // Log every 12th poll (~60s) to confirm poller is alive
  if (_pollCount <= 3 || _pollCount % 12 === 0) {
    console.log(`[POLL #${_pollCount}] checking... (slots: ${MAX_CONCURRENT - pool.interactionNicks.size}, nicks running: ${pool.interactionNicks.size})`)
  }
  try {
    const slots = MAX_CONCURRENT - pool.interactionNicks.size
    let jobs, pollError

    if (useApi()) {
      // â”€â”€ REST API mode: job polling via HTTP â”€â”€
      try {
        jobs = await api.getPendingJobs(slots)
      } catch (err) {
        pollError = err
        console.error(`[POLL] API error: ${err.message}`)
      }
    } else {
      // â”€â”€ Direct DB mode (legacy fallback) â”€â”€
      // Láº¥y Rá»˜NG hÆ¡n sá»‘ slot (khÃ´ng chá»‰ top-N priority) Ä‘á»ƒ fair-pick per nick
      // bÃªn dÆ°á»›i cÃ³ dá»¯ liá»‡u â€” fix starvation 23/08: `LIMIT slots` toÃ n cá»¥c lÃ m
      // nick cÃ³ dÃ²ng job p1-p7 liÃªn tá»¥c (kpi nurture) chiáº¿m cáº£ 2 slot vÄ©nh
      // viá»…n, job p30/p35 (feed_seed/check_replies) cá»§a nick khÃ¡c KHÃ”NG BAO GIá»œ
      // lá»t top â†’ Lorena Ä‘Ã³i 7 tiáº¿ng ban ngÃ y, má»i job bá»‹ stale-huá»·.
      let query = supabase
        .from('jobs')
        .select('*')
        .eq('status', 'pending')
        .lte('scheduled_at', new Date().toISOString())
        .order('priority', { ascending: true })
        .order('scheduled_at', { ascending: true })
        .limit(Math.max(slots * 10, 30))

      // RANH GIá»šI TENANT: user Ä‘ang Ä‘Äƒng nháº­p trÃªn mÃ¡y nÃ y thÃ¬ chá»‰ nháº·t job
      // cá»§a chÃ­nh há». Cháº¡y job cá»§a user khÃ¡c = náº¡p cookie Facebook cá»§a há» vÃ o
      // browser trÃªn mÃ¡y nÃ y. Xem ghi chÃº dÃ i á»Ÿ lib/api-client.js
      // getPendingJobs() (nhÃ¡nh REST API â€” Ä‘Æ°á»ng cháº¡y chÃ­nh).
      const ALLOWED_USER_IDS = (process.env.ALLOWED_USER_IDS || '').split(',').map(s => s.trim()).filter(Boolean)
      if (ALLOWED_USER_IDS.length) {
        // MÃ¡y farm chung â€” cháº¡y nick cá»§a má»i user trong danh sÃ¡ch (xem api-client)
        query = query.in('created_by', ALLOWED_USER_IDS)
      } else if (AGENT_USER_ID) {
        query = query.eq('created_by', AGENT_USER_ID)
      } else {
        const excludedUserIds = await getExcludedUserIds()
        if (excludedUserIds.length > 0) {
          query = query.not('created_by', 'in', `(${excludedUserIds.join(',')})`)
        }
      }

      const result = await query
      jobs = result.data
      if (result.error) {
        pollError = result.error
        console.error(`[POLL] Query error: ${result.error.message}`)
      }

      // â”€â”€ FAIR-PICK PER NICK (chá»‘ng starvation, 23/08) â”€â”€
      // Má»—i nick chá»‰ 1 job Ä‘áº¡i diá»‡n (job priority nhá» nháº¥t cá»§a nick Ä‘Ã³ â€” list Ä‘Ã£
      // sort), rá»“i xáº¿p NICK ÄÃ“I LÃ‚U NHáº¤T trÆ°á»›c (nickLastClaimAt cÅ© nháº¥t). Job
      // khÃ´ng gáº¯n nick (system) giá»¯ nguyÃªn Ä‘áº§u hÃ ng theo priority. Káº¿t quáº£ cáº¯t
      // vá» Ä‘Ãºng `slots`. Nhá» váº­y nick cÃ³ job p35 váº«n Ä‘Æ°á»£c phá»¥c vá»¥ Ä‘á»u thay vÃ¬
      // bá»‹ nick cÃ³ dÃ²ng p1 má»›i liÃªn tá»¥c Ä‘Ã¨ vÄ©nh viá»…n.
      if (jobs?.length) {
        const noNick = []
        const perNick = new Map()   // account_id â†’ job Æ°u tiÃªn nháº¥t cá»§a nick
        for (const j of jobs) {
          const a = j.payload?.account_id
          if (!a) { noNick.push(j); continue }
          if (!perNick.has(a)) perNick.set(a, j)
        }
        const nickJobs = [...perNick.entries()]
          .sort((x, y) => (nickLastClaimAt.get(x[0]) || 0) - (nickLastClaimAt.get(y[0]) || 0))
          .map(([, j]) => j)
        jobs = [...noNick, ...nickJobs].slice(0, slots)
      }
    }
    if (!jobs?.length) {
      _consecutiveEmptyPolls++
      // Auto-boost KPI & enqueue seeding nurture jobs if queue remains empty for 30s
      if (_consecutiveEmptyPolls % 6 === 1) {
        triggerKpiBoostSafe()
      }
      // No pending jobs â€” BUT check if any jobs are currently running before closing browsers
      const hasRunningJobs = pool.runningJobs && pool.runningJobs.size > 0
      const hasRestingNick = [...nickRestUntil.entries()].some(([_, r]) => r.until > Date.now())

      if (!hasRunningJobs && !hasRestingNick) {
        const sessionPool = require('../browser/session-pool')
        const openCount = sessionPool.getSessionCount?.() || 0
        if (openCount > 0) {
          console.log(`[POLLER] No pending/running jobs, no resting nicks â†’ closing ${openCount} idle browser(s)`)
          await sessionPool.closeAll()
        }
      }
      return false
    }

    let hasClaimedAny = false
    for (const job of jobs) {
      // â”€â”€â”€ Automated Stale Job Prevention â”€â”€â”€
      // KPI boost jobs (force_now=true or kpi_boost=true) are EXEMPT from stale check â€”
      // they are re-enqueued periodically and should always run regardless of age.
      // Other jobs: stale threshold is 4h (was 1h â€” too aggressive, cancelled jobs before they ran).
      const isKpiBoostJob = job.payload?.kpi_boost === true || job.payload?.force_now === true
      // Comment QUáº¢NG CÃO (is_ad, feed-seed 01/09) cÅ©ng hÆ°á»Ÿng ngÆ°á»¡ng 12h: Ä‘o
      // 27-31/08 cÃ³ 7 comment quáº£ng cÃ¡o cháº¿t oan vÃ¬ stale trong khi tráº§n ngÃ y
      // má»›i dÃ¹ng ~25% â€” quáº£ng cÃ¡o lÃ  thá»© user muá»‘n Æ°u tiÃªn, Ä‘áº¿n muá»™n váº«n hÆ¡n máº¥t.
      const isAdJob = job.payload?.is_ad === true
      const STALE_THRESHOLD_MS = (isKpiBoostJob || isAdJob) ? (12 * 60 * 60 * 1000) : (4 * 60 * 60 * 1000) // 12h for KPI/ad, 4h for others
      // Use scheduled_at (when it should run) not created_at (when it was queued)
      const jobTime = job.scheduled_at ? new Date(job.scheduled_at).getTime() : (job.created_at ? new Date(job.created_at).getTime() : 0)
      if (jobTime && (Date.now() - jobTime) > STALE_THRESHOLD_MS) {
        const ageH = ((Date.now() - jobTime) / 3600000).toFixed(1)
        console.warn(`[POLLER] Stale job detected: ${job.type} (${job.id}) ${ageH}h old. Auto-cancelling.`)
        try {
          if (useApi()) {
            await api.updateJobStatus(job.id, 'cancelled', { error_message: `Stale job auto-cancelled by agent (older than ${(isKpiBoostJob || isAdJob) ? '12' : '4'} hours).` })
          } else {
            await supabase.from('jobs').update({ status: 'cancelled', error_message: `Stale job auto-cancelled by agent (older than ${(isKpiBoostJob || isAdJob) ? '12' : '4'} hours).` }).eq('id', job.id)
          }
        } catch (cancelErr) {
          console.error(`[POLLER] Failed to auto-cancel stale job ${job.id}: ${cancelErr.message}`)
        }
        continue
      }

      const accId = job.payload?.account_id
      const isPostJob = POST_TYPES.includes(job.type)

      // 1 nick = 1 browser = 1 job táº¡i 1 thá»i Ä‘iá»ƒm
      // Job sau Äá»¢I job trÆ°á»›c xong â€” khÃ´ng skip, khÃ´ng cancel, chá»‰ defer
      const isUtility = UTILITY_TYPES.includes(job.type)
      if (accId && pool.isRunning(accId)) continue // sáº½ Ä‘Æ°á»£c pick up á»Ÿ poll cycle tiáº¿p theo

      // Per-nick post cooldown (not global â€” each nick tracks independently)
      if (isPostJob && accId) {
        const cd = nickCooldowns.get(accId)
        if (cd && cd.lastPostAt > 0) {
          const elapsed = Date.now() - cd.lastPostAt
          if (elapsed < cd.cooldownMs) {
            continue // this nick is cooling down, try next job
          }
        }
      }

      // Per-nick action gap enforcement
      const actionType = JOB_ACTION_MAP[job.type]
      if (actionType && accId) {
        const gapKey = `${accId}:${actionType}`
        const lastAt = nickActionTimestamps.get(gapKey)
        if (lastAt) {
          const minGap = getMinGapMs(actionType)
          if (Date.now() - lastAt < minGap) continue
        }
      }

      // Per-nick account status check (skip disabled/checkpoint/expired accounts).
      // Phase 15 fix: diagnostic jobs (check_health, check_group_membership,
      // fetch_source_cookie) MUST bypass this gate â€” they're the mechanism to
      // RECOVER an inactive nick. Only cancel user-facing interaction jobs.
      // Only check_health bypasses â€” it's the ONLY job that should touch
      // an inactive account (to verify if cookie was refreshed by user).
      // fetch_source_cookie, warmup_browse etc. must NOT run on expired/
      // checkpoint accounts â€” opening a browser without valid session is
      // suspicious behavior that FB can flag.
      const BYPASS_ACTIVE_CHECK = new Set([
        'check_health',
      ])
      if (accId && !BYPASS_ACTIVE_CHECK.has(job.type)) {
        const statusOk = await checkAccountActive(accId)
        if (!statusOk) {
          // Auto-cancel job for inactive nick â€” prevent infinite skip loop
          try {
            if (useApi()) {
              await api.cancelInactiveJob(job.id, accId)
            } else {
              await supabase.from('jobs').update({ status: 'cancelled', error_message: 'account_not_active', finished_at: new Date().toISOString() }).eq('id', job.id).eq('status', 'pending')
            }
          } catch {}
          console.log(`[POLLER] Nick ${accId.slice(0,8)} not active â€” CANCELLED ${job.type} job ${job.id}`)
          continue
        }
      }

      // Per-campaign active status check (skip and immediately cancel jobs belonging to deactivated campaigns)
      if (job.payload?.campaign_id) {
        const campaignActive = await checkCampaignActive(job.payload.campaign_id)
        if (!campaignActive) {
          try {
            if (useApi()) {
              await api.cancelInactiveJob(job.id, accId)
            } else {
              await supabase.from('jobs').update({ status: 'cancelled', error_message: 'campaign_inactive' }).eq('id', job.id).eq('status', 'pending')
            }
          } catch {}
          console.log(`[POLLER] Campaign ${job.payload.campaign_id.slice(0, 8)} is INACTIVE â€” CANCELLED ${job.type} job ${job.id}`)
          continue
        }
      }

      // Per-nick risk level check (early warning system)
      if (accId && !UTILITY_TYPES.includes(job.type)) {
        try {
          const { getWarningScore } = require('../lib/signal-collector')
          const warning = await getWarningScore(accId)
          if (warning.risk_level === 'critical') {
            // Critical: pause nick, cancel job
            try {
              await supabase.from('jobs').update({ status: 'cancelled', error_message: 'risk_level_critical' }).eq('id', job.id).eq('status', 'pending')
              await supabase.from('accounts').update({ status: 'at_risk' }).eq('id', accId)
              await supabase.from('notifications').insert({
                user_id: job.created_by || job.payload?.owner_id,
                type: 'account_risk',
                title: `Nick ${accId.slice(0, 8)} á»Ÿ má»©c CRITICAL`,
                body: `${warning.signals_6h} cáº£nh bÃ¡o trong 6h. Nick Ä‘Ã£ táº¡m dá»«ng tá»± Ä‘á»™ng.`,
                level: 'urgent',
              }).catch(() => {})
            } catch {}
            console.log(`[POLLER] â›” Nick ${accId.slice(0, 8)} CRITICAL (${warning.signals_6h} signals/6h) â€” CANCELLED + paused`)
            continue
          }
          if (warning.risk_level === 'warning') {
            console.log(`[POLLER] âš ï¸ Nick ${accId.slice(0, 8)} WARNING (${warning.signals_24h} signals/24h) â€” reducing budget 50%`)
            // Tag this job so handler knows to reduce actions
            job._riskReduction = 0.5
          }
        } catch {}
      }

      // Per-nick active hours check (Asia/Ho_Chi_Minh timezone)
      // 24/7 mode: active_hours_start=0 AND active_hours_end=24 â†’ bypass entirely
      // force_now bypasses (admin manual emit overrides hours).
      // KPI boost jobs always bypass active hours gate (must run to hit daily targets).
      if (accId && !UTILITY_TYPES.includes(job.type) && !job.payload?.force_now && !job.payload?.kpi_boost) {
        const cached = accountStatusCache.get(accId)
        if (cached) {
          // Default: 0-24 (24/7) if not explicitly configured â€” was 7-23 which caused night-time 0 throughput
          const startH = cached.active_hours_start ?? 0
          const endH = cached.active_hours_end ?? 24
          const is247 = startH === 0 && endH === 24
          if (!is247) {
            const vnNow = new Date(Date.now() + 7 * 3600 * 1000)
            const vnHour = vnNow.getUTCHours()
            if (vnHour < startH || vnHour >= endH) {
              continue // outside active hours â€” job stays pending
            }
          }
        }
      }

      // Warm-up KHÃ”NG cÃ²n cháº·n job theo tuá»•i nick. Nick cháº¡y liÃªn tá»¥c theo KPI;
      // khá»‘i lÆ°á»£ng do applyAgeFactor (nick má»›i giáº£m nháº¹) + HARD_LIMITS Ä‘iá»u tiáº¿t,
      // vÃ  KPI gate ngay bÃªn dÆ°á»›i má»›i lÃ  thá»© quyáº¿t Ä‘á»‹nh nick cÃ²n viá»‡c hay khÃ´ng.

      // Phase 11: per-nick KPI gate â€” skip if this nick has already met its
      // share for THIS job's action type today (frees the slot for nicks behind).
      // Maps job.type â†’ KPI action field.
      const KPI_FIELD_MAP = {
        campaign_nurture: 'comments',           // primary action
        campaign_send_friend_request: 'friend_requests',
        campaign_discover_groups: 'group_joins',
      }
      const kpiField = KPI_FIELD_MAP[job.type]
      const campaignIdForKpi = job.payload?.campaign_id
      // force_now bypasses KPI gate (admin run regardless of daily target met).
      if (accId && campaignIdForKpi && kpiField && !job.payload?.force_now) {
        try {
          // VN date (UTC+7) â€” must match kpi-calculator.js + activity-logger.js
          const today = new Date(Date.now() + 7 * 3600000).toISOString().split('T')[0]
          const { data: kpiRow } = await supabase.from('nick_kpi_daily')
            .select('kpi_met, target_likes, done_likes, target_comments, done_comments, target_friend_requests, done_friend_requests, target_group_joins, done_group_joins')
            .eq('campaign_id', campaignIdForKpi)
            .eq('account_id', accId)
            .eq('date', today)
            .maybeSingle()
          if (kpiRow) {
            // Guard: if all targets=0, the row was created by increment_kpi
            // before rebalance ran â€” ignore kpi_met (it would be true because
            // target=0 OR done>=target, both trivially satisfied).
            const hasTargets = (kpiRow.target_likes || 0) > 0 ||
                              (kpiRow.target_comments || 0) > 0 ||
                              (kpiRow.target_friend_requests || 0) > 0 ||
                              (kpiRow.target_group_joins || 0) > 0
            if (kpiRow.kpi_met && hasTargets) {
              console.log(`[POLLER] Nick ${accId.slice(0,8)} KPI met today â€” yielding slot`)
              continue
            }
            // Action-specific check
            const targetField = `target_${kpiField}`
            const doneField = `done_${kpiField}`
            const tgt = kpiRow[targetField] || 0
            const done = kpiRow[doneField] || 0
            if (tgt > 0 && done >= tgt) {
              console.log(`[POLLER] Nick ${accId.slice(0,8)} ${kpiField} KPI met (${done}/${tgt}) â€” skipping ${job.type}`)
              continue
            }
          }
        } catch {}
      }

      // Phase 16: group visit isolation â€” max 2 different nicks in same group within 30min.
      // Only for nurture/interact/monitor jobs that target a specific group.
      if (accId && ['campaign_nurture', 'campaign_interact_profile', 'campaign_group_monitor'].includes(job.type)) {
        const groupFbId = job.payload?.fb_group_id || job.payload?.group_id
        if (groupFbId) {
          try {
            const nowIso = new Date().toISOString()
            const { data: leases } = await supabase
              .from('group_visit_leases')
              .select('account_id')
              .eq('group_id', groupFbId)
              .gt('slot_end', nowIso)
            
            const activeOtherAccounts = [...new Set((leases || [])
              .map(v => v.account_id)
              .filter(id => id !== accId)
            )]
            if (activeOtherAccounts.length >= 2) {
              console.log(`[POLLER] Group ${groupFbId} has reached visit limit (2 other nicks active) â€” deferring job ${job.id}`)
              continue // skip claiming this job for now
            }
          } catch (leaseErr) {
            console.warn(`[POLLER] Group visit lease check failed: ${leaseErr.message}`)
          }
        }
      }

      // Per-nick hourly rate limit (max 50 actions/hour across all types)
      // force_now bypasses (admin manual override).
      if (accId && !job.payload?.force_now) {
        const hourly = nickHourlyActions.get(accId)
        if (hourly) {
          if (Date.now() > hourly.resetAt) {
            nickHourlyActions.set(accId, { count: 0, resetAt: Date.now() + 3600000 })
          } else if (hourly.count >= MAX_HOURLY_ACTIONS) {
            console.log(`[POLLER] Nick ${accId.slice(0,8)} hit hourly limit (${MAX_HOURLY_ACTIONS}), skipping`)
            continue
          }
        }
      }

      // Per-nick session duration cap (25-45min random continuous work)
      if (accId) {
        const sessionStart = nickSessionStart.get(accId)
        // Each nick gets a random session max on first check
        if (!nickSessionStart.has(`${accId}_max`)) nickSessionStart.set(`${accId}_max`, randSessionMax())
        const sessionMax = nickSessionStart.get(`${accId}_max`)
        if (sessionStart && (Date.now() - sessionStart) > sessionMax) {
          const durMin = Math.round((Date.now() - sessionStart) / 60000)
          console.log(`[POLLER] Nick ${accId.slice(0,8)} session ${durMin}min, forcing rest`)
          nickSessionStart.delete(accId)
          nickSessionStart.delete(`${accId}_max`)
          const restMs = randRestMs()
          nickRestUntil.set(accId, { until: Date.now() + restMs, durationMin: Math.round(restMs / 60000) })
          try { const { releaseSession } = require('../browser/session-pool'); releaseSession(accId) } catch {}
          continue
        }
      }

      // Per-nick rest period (20-45min random gap by default).
      // Bypass: payload.force_now=true skips this single job past the rest
      // gate (manual admin emit / smoke tests). Other jobs for the same nick
      // still respect the rest.
      if (accId && !job.payload?.force_now) {
        const rest = nickRestUntil.get(accId)
        if (rest && Date.now() < rest.until) {
          const remainMin = Math.round((rest.until - Date.now()) / 60000)
          if (!nickSessionStart.has(`${accId}_restlog`) || Date.now() - nickSessionStart.get(`${accId}_restlog`) > 300000) {
            console.log(`[POLLER] Nick ${accId.slice(0,8)} resting (${remainMin}/${rest.durationMin}min)`)
            nickSessionStart.set(`${accId}_restlog`, Date.now())
          }
          continue
        }
        if (rest && Date.now() >= rest.until) nickRestUntil.delete(accId)
      } else if (accId && job.payload?.force_now) {
        console.log(`[POLLER] Nick ${accId.slice(0,8)} force_now â†’ bypass rest gate for job ${job.id?.slice(0,8)}`)
      }

      // Per-nick budget pre-check (avoid claiming if daily limit already reached)
      // 2026-05-02: force_now bypasses budget too (same as rest). Stuck-loop
      // pattern observed: force_now bypass rest â†’ budget check fails â†’ skip
      // â†’ job stays pending â†’ next 15s poll re-checks â†’ loop. Whole point of
      // force_now is "run this regardless of normal gates".
      // feed_scroll KHÃ”NG bá»‹ cháº·n á»Ÿ Ä‘Ã¢y (26/08): handler tá»± háº¡ xuá»‘ng cháº¿ Ä‘á»™ chá»‰
      // lÆ°á»›t khi háº¿t háº¡n má»©c feed_like, váº«n quÃ©t + dwell Ä‘á»ƒ nuÃ´i thuáº­t toÃ¡n.
      // Cháº·n á»Ÿ cá»•ng nÃ y thÃ¬ job khÃ´ng Ä‘Æ°á»£c nháº­n, cÅ©ng KHÃ”NG bá»‹ huá»· â€” nÃ³ náº±m
      // pending tá»›i khi stale_pending_timeout dá»n sau 2 tiáº¿ng, vÃ  bÃ¡o cÃ¡o ra
      // ngoÃ i thÃ nh "hÃ ng Ä‘á»£i quÃ¡ táº£i" thay vÃ¬ "háº¿t háº¡n má»©c like". Ca tháº­t
      // 26/08: nick im láº·ng trÃªn newsfeed tá»« 20:20 tá»›i ná»­a Ä‘Ãªm vÃ¬ Ä‘Ãºng lá»—i nÃ y.
      const budgetGated = actionType && accId && !job.payload?.force_now && job.type !== 'feed_scroll'
      if (budgetGated) {
        const budgetOk = await checkBudgetBeforeClaim(accId, actionType)
        if (!budgetOk) {
          // Suppress spam: only log once per nick+action until reset
          const logKey = `budget_log:${accId}:${actionType}`
          if (!nickBudgetExhaustedLog.has(logKey)) {
            nickBudgetExhaustedLog.add(logKey)
            console.log(`[POLLER] Nick ${accId.slice(0,8)} budget exhausted for ${actionType}, skipping (further logs suppressed until reset)`)
          }
          continue
        }
      }

      // ATOMIC: Acquire pool slot BEFORE claiming in DB
      // This prevents race: two poll cycles both see nick as free
      if (accId) {
        pool.acquire(accId, job.id, job.type)
        // Start session timer if not already running
        if (!nickSessionStart.has(accId)) {
          nickSessionStart.set(accId, Date.now())
        }
      }

      // Claim job (atomic â€” only succeeds if still pending)
      let claimOk = false
      if (useApi()) {
        try {
          await api.claimJob(job.id)
          claimOk = true
        } catch (err) {
          if (err.status !== 409) console.error(`[POLL] Claim API error: ${err.message}`)
        }
      } else {
        const { data: claimed, error } = await supabase.from('jobs')
          .update({ status: 'claimed', agent_id: AGENT_ID, started_at: new Date() })
          .eq('id', job.id)
          .eq('status', 'pending')
          .select('id')
        claimOk = !error && claimed?.length > 0
      }

      if (!claimOk) {
        // Another agent/poll claimed it â€” release pool slot
        if (accId) {
          pool.release(accId, job.id)
          // FIX Bug#4: also clean up session timer that was started before claim â€” it leaked otherwise
          if (!pool.isRunning(accId)) nickSessionStart.delete(accId)
        }
        continue
      }

      hasClaimedAny = true

      // Set pessimistic cooldown + timestamps AT CLAIM TIME (not after completion)
      // This prevents next poll from picking up another job for this nick
      if (isPostJob && accId) {
        nickCooldowns.set(accId, { lastPostAt: Date.now(), cooldownMs: 10 * 60000 }) // pessimistic 10min
      }
      if (actionType && accId) {
        nickActionTimestamps.set(`${accId}:${actionType}`, Date.now())
      }
      // Optimistic budget increment (prevents race: 2 jobs same nick in 1 poll cycle)
      if (actionType && accId) {
        const cached = nickBudgetCache.get(accId)
        if (cached?.budget?.[actionType]) {
          cached.budget[actionType].used = (cached.budget[actionType].used || 0) + 1
        }
      }
      // Increment hourly counter
      if (accId) {
        const hourly = nickHourlyActions.get(accId) || { count: 0, resetAt: Date.now() + 3600000 }
        hourly.count++
        nickHourlyActions.set(accId, hourly)
        nickLastClaimAt.set(accId, Date.now())   // má»‘c phá»¥c vá»¥ â€” fair-pick xáº¿p nick Ä‘Ã³i trÆ°á»›c
      }

      console.log(`[JOB] Claimed ${job.type} (${job.id}) [${pool.interactionNicks.size}/${MAX_CONCURRENT} browser${pool.httpOnlyNicks.size ? ` +${pool.httpOnlyNicks.size} http-only` : ''}]`)

      // Fire & forget â€” don't await, allows concurrent execution
      executeJob(job).finally(() => {
        pool.release(accId, job.id)

        // Update cooldown with actual value (overwrite pessimistic)
        if (isPostJob && accId) {
          const cd = postCooldown()
          nickCooldowns.set(accId, { lastPostAt: Date.now(), cooldownMs: cd })
          console.log(`[POLLER] Nick ${accId.slice(0,8)} post done, cooldown: ${(cd / 60000).toFixed(1)}min`)
        }

        // Update action timestamp (overwrite claim-time value)
        if (actionType && accId) {
          nickActionTimestamps.set(`${accId}:${actionType}`, Date.now())
        }

        // Invalidate budget cache + log suppression so next poll fetches fresh
        if (accId) {
          nickBudgetCache.delete(accId)
          // Clear all budget exhausted log suppressions for this nick
          for (const key of nickBudgetExhaustedLog) {
            if (key.startsWith(`budget_log:${accId}:`)) nickBudgetExhaustedLog.delete(key)
          }
        }

        // If nick has no more running jobs, end session tracking
        // (next job will start a fresh session timer)
        if (accId && !pool.isRunning(accId)) {
          const sessionStart = nickSessionStart.get(accId)
          if (sessionStart) {
            const durationMin = Math.round((Date.now() - sessionStart) / 60000)
            console.log(`[POLLER] Nick ${accId.slice(0,8)} session ended after ${durationMin}min`)
            nickSessionStart.delete(accId)
            // Only rest after interaction jobs that actually did work (> 1 min)
            const isInteraction = (job.type || '').startsWith('campaign_') ||
              ['comment_post', 'post_page', 'post_group', 'post_profile', 'join_group'].includes(job.type)
            if (isInteraction && durationMin >= 1) {
              const restMs = randRestMs()
              const restMin = Math.round(restMs / 60000)
              nickRestUntil.set(accId, { until: Date.now() + restMs, durationMin: restMin })
              nickSessionStart.delete(`${accId}_max`)
              console.log(`[POLLER] Nick ${accId.slice(0,8)} â†’ rest ${restMin}min (after ${durationMin}min work)`)
            } else if (isInteraction && durationMin < 1) {
              console.log(`[POLLER] Nick ${accId.slice(0,8)} â†’ no rest (session was ${durationMin}min, skipped/failed)`)
            }
          }
        }
      })
    }
  } catch (err) {
    pollFails++
    if (pollFails === 1 || pollFails % 6 === 0) {
      console.error(`[POLL ERROR] ${err.message} (failed ${pollFails}x, retrying every ${POLL_MS / 1000}s)`)
    }
    return false
  } finally {
    _polling = false
  }
  if (pollFails > 0) {
    console.log(`[POLLER] Reconnected after ${pollFails} poll failures`)
    pollFails = 0
  }
  return hasClaimedAny
}

async function executeJob(job) {
  // Use payload.action for routing if available, otherwise fall back to job.type
  // This allows using allowed DB types (like check_health) while routing to specific handlers
  const handlerKey = job.payload?.action || job.type
  const handler = handlers.get(handlerKey)
  if (!handler) {
    console.error(`[JOB] No handler for: ${handlerKey} (type: ${job.type})`)
    await updateJobStatus(job.id, 'failed', null, `Handler not found: ${handlerKey}`)
    return
  }

  let heartbeatInterval;
  try {
    await updateJobStatus(job.id, 'running')
    console.log(`[JOB] Running ${handlerKey} (${job.id})`)

    // Start heartbeat interval (every 45s) to update last_heartbeat_at on jobs table
    heartbeatInterval = setInterval(async () => {
      try {
        if (useApi()) {
          await api.updateJobStatus(job.id, 'running', { last_heartbeat_at: new Date().toISOString() })
        } else {
          await supabase.from('jobs').update({ last_heartbeat_at: new Date().toISOString() }).eq('id', job.id)
        }
      } catch (hbErr) {
        console.warn(`[JOB-HEARTBEAT] Failed to update heartbeat for job ${job.id}: ${hbErr.message}`)
      }
    }, 45000);

    // Check campaign still active (for campaign jobs only)
    if (job.payload?.campaign_id && handlerKey.startsWith('campaign_')) {
      const { data: camp } = await supabase.from('campaigns')
        .select('status').eq('id', job.payload.campaign_id).single()
      if (camp && !['active', 'running'].includes(camp.status)) {
        console.log(`[JOB] Campaign ${job.payload.campaign_id} is ${camp.status} â€” CANCELLED job ${job.id}`)
        if (heartbeatInterval) clearInterval(heartbeatInterval)
        await updateJobStatus(job.id, 'cancelled', null, `campaign_${camp.status}`)
        return
      }
    }

    // Re-check in case user cancelled after claim
    const { data: statusRow } = await supabase
      .from('jobs')
      .select('status')
      .eq('id', job.id)
      .single()
    if (statusRow?.status === 'cancelled') {
      console.log(`[JOB] Cancelled before start ${handlerKey} (${job.id})`)
      if (heartbeatInterval) clearInterval(heartbeatInterval)
      await updateJobStatus(job.id, 'cancelled')
      return
    }

    // Wrap handler to allow mid-run cancel checks if handler returns a promise
    const result = await handler({ ...job.payload, job_id: job.id }, supabase)
    // Final cancel check before marking done
    const { data: finalStatus } = await supabase
      .from('jobs')
      .select('status')
      .eq('id', job.id)
      .single()
    if (finalStatus?.status === 'cancelled') {
      console.log(`[JOB] Marked cancelled after handler ${handlerKey} (${job.id})`)
      if (heartbeatInterval) clearInterval(heartbeatInterval)
      await updateJobStatus(job.id, 'cancelled')
      return
    }

    if (heartbeatInterval) clearInterval(heartbeatInterval)
    await updateJobStatus(job.id, 'done', result)
    console.log(`[JOB] Done ${handlerKey} (${job.id})`)

    // Reset consecutive skip counter on success
    if (job.payload?.campaign_id) {
      const skipKey = `${job.payload.campaign_id}_${job.payload.role_id || 'default'}`
      consecutiveSkips.delete(skipKey)
    }
  } catch (err) {
    if (heartbeatInterval) clearInterval(heartbeatInterval)
    // Session pool busy â†’ don't fail, reset to pending and let next poll retry
    if (err.code === 'SESSION_POOL_BUSY' || err.message === 'SESSION_POOL_BUSY') {
      console.log(`[JOB] Session pool busy, requeue ${handlerKey} (${job.id}) for retry in 30s`)
      try {
        if (useApi()) {
          await api.updateJobStatus(job.id, 'pending', { scheduled_at: new Date(Date.now() + 30000).toISOString() })
        } else {
          await supabase.from('jobs').update({
            status: 'pending',
            scheduled_at: new Date(Date.now() + 30000).toISOString(),
          }).eq('id', job.id)
        }
      } catch {}
      return // skip the rest of the error handling â€” not a real failure
    }

    const classified = classifyError(err.message)
    console.error(`[JOB] Error ${handlerKey} (${job.id}) [${classified.type}]:`, err.message)

    const maxAttempts = job.max_attempts || 3
    const nextAttempt = (job.attempt || 0) + 1

    // â”€â”€â”€ BROWSER_CRASH: clear profile lock + requeue, NEVER disable account â”€â”€
    // Browser launch failures (lock files, process kill, etc) are infrastructure
    // problems, not account problems. Don't penalize the nick.
    if (classified.isBrowserCrash && job.payload?.account_id) {
      try {
        const path = require('path')
        const os = require('os')
        const { clearProfileLock } = require('../browser/launcher')
        const userDataDir = path.join(os.homedir(), '.socialflow', 'profiles', job.payload.account_id, 'browser-data')
        clearProfileLock(userDataDir)
      } catch (clearErr) {
        console.warn(`[JOB] clearProfileLock failed: ${clearErr.message}`)
      }
      // Write failure log to DB for diagnostics before requeueing
      try {
        await supabase.from('job_failures').insert({
          job_id: job.id,
          account_id: job.payload?.account_id || null,
          campaign_id: job.payload?.campaign_id || null,
          error_type: classified.type,
          error_message: err.message,
          error_stack: err.stack?.substring(0, 2000),
          handler_name: handlerKey,
        })
      } catch (logErr) {
        console.warn(`[JOB] Failed to insert BROWSER_CRASH diagnostic log: ${logErr.message}`)
      }

      // Requeue with 60s delay â€” don't increment attempt counter, don't fail
      try {
        const errorMsg = `BROWSER_CRASH â€” ${err.message}`
        if (useApi()) {
          await api.updateJobStatus(job.id, 'pending', {
            scheduled_at: new Date(Date.now() + 60000).toISOString(),
            error_message: errorMsg,
          })
        } else {
          await supabase.from('jobs').update({
            status: 'pending',
            scheduled_at: new Date(Date.now() + 60000).toISOString(),
            error_message: errorMsg,
          }).eq('id', job.id)
        }
      } catch {}
      console.log(`[JOB] BROWSER_CRASH ${handlerKey} (${job.id}) â€” cleared lock, requeue in 60s (no penalty)`)
      return // skip rest of error handling
    }

    // â”€â”€â”€ Save to job_failures table â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const failureData = {
      job_id: job.id,
      account_id: job.payload?.account_id || null,
      campaign_id: job.payload?.campaign_id || null,
      error_type: classified.type,
      error_message: err.message,
      error_stack: err.stack?.substring(0, 2000),
      handler_name: handlerKey,
      page_url: err.pageUrl || null,
      attempt: nextAttempt,
      will_retry: isRetryable(classified) && nextAttempt < maxAttempts,
      next_retry_at: isRetryable(classified) && nextAttempt < maxAttempts
        ? new Date(Date.now() + getRetryDelayMs(classified, nextAttempt - 1)).toISOString() : null,
    }
    try {
      if (useApi()) {
        await api.recordJobFailure(failureData)
      } else {
        await supabase.from('job_failures').insert(failureData)
      }
    } catch (insertErr) {
      console.error(`[JOB] Failed to save job_failure:`, insertErr.message)
    }

    // â”€â”€â”€ CHECKPOINT â†’ disable immediately, no double-check â”€â”€
    // Checkpoint = Facebook requires manual verification (selfie, ID, etc.)
    // No point retrying or health-checking â€” disable right away
    if (classified.type === 'CHECKPOINT' && job.payload?.account_id) {
      console.log(`[JOB] CHECKPOINT detected for ${job.payload.account_id.slice(0, 8)} â€” disabling account immediately`)
    }

    // â”€â”€â”€ Update account status if needed â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    if (shouldDisableAccount(classified) && job.payload?.account_id) {
      const newStatus = classified.newStatus || 'checkpoint'

      // Prefer new API endpoint â€” atomically sets status + cancels all pending jobs + notifies user
      if (useApi()) {
        try {
          const axios = require('axios')
          const API_URL = process.env.API_URL || _pollerCfg.API_URL || 'http://localhost:3000'
          const _secret = process.env.AGENT_SECRET || process.env.AGENT_SECRET_KEY || _pollerCfg.AGENT_SECRET_KEY
          await axios.patch(
            `${API_URL}/accounts/${job.payload.account_id}/status`,
            { status: newStatus, reason: err.message?.substring(0, 200), detected_at: new Date().toISOString() },
            { headers: { 'X-Agent-Key': _secret }, timeout: 10000 }
          )
          console.log(`[JOB] Account ${job.payload.account_id.slice(0,8)} â†’ ${newStatus} (via API, jobs cancelled + user notified)`)
        } catch (apiErr) {
          // Fallback: direct DB update
          await supabase.from('accounts').update({ status: newStatus, is_active: false }).eq('id', job.payload.account_id)
          console.log(`[JOB] Account ${job.payload.account_id.slice(0,8)} â†’ ${newStatus} (DB fallback, API failed: ${apiErr.message})`)
          await ensureAccountAlert(supabase, job.payload.account_id, newStatus, newStatus === 'checkpoint' ? 'critical' : 'warning', err.message?.substring(0, 200))
        }
      } else {
        await supabase.from('accounts').update({ status: newStatus, is_active: false }).eq('id', job.payload.account_id)
        console.log(`[JOB] Account ${job.payload.account_id} marked as ${newStatus}`)
        await ensureAccountAlert(supabase, job.payload.account_id, newStatus, newStatus === 'checkpoint' ? 'critical' : 'warning', err.message?.substring(0, 200))
      }
      // Invalidate status cache immediately
      accountStatusCache.delete(job.payload.account_id)

      // Auto-queue health check to try refreshing cookie (only for SESSION_EXPIRED, not CHECKPOINT)
      if (classified.type === 'SESSION_EXPIRED') {
        try {
          const { data: existing } = await supabase.from('jobs')
            .select('id')
            .eq('type', 'check_health')
            .eq('payload->>account_id', job.payload.account_id)
            .in('status', ['pending', 'claimed', 'running'])
            .limit(1)
          if (!existing?.length) {
            await supabase.from('jobs').insert({
              type: 'check_health',
              priority: 1, // CRITICAL
              payload: { account_id: job.payload.account_id, action: 'check_health', auto_refresh: true },
              status: 'pending',
              scheduled_at: new Date(Date.now() + 60000).toISOString(), // 1 phut sau
              created_by: job.created_by,
            })
            console.log(`[JOB] Auto-queued health check for expired account ${job.payload.account_id}`)
          }
        } catch (e) {
          console.warn(`[JOB] Failed to queue auto health check:`, e.message)
        }
      }

      // Create notification for user
      if (classified.alertLevel && job.created_by) {
        try {
          const { data: acct } = await supabase.from('accounts').select('username').eq('id', job.payload.account_id).single()
          const nick = acct?.username || job.payload.account_id
          await supabase.from('notifications').insert({
            user_id: job.created_by,
            type: classified.type === 'CHECKPOINT' ? 'checkpoint' : 'session_expired',
            title: classified.alertMsg ? classified.alertMsg(nick) : `Nick loi: ${classified.type}`,
            body: `Job ${handlerKey} that bai sau ${nextAttempt} lan. Loi: ${err.message.slice(0, 200)}`,
            level: classified.alertLevel,
            data: { job_id: job.id, account_id: job.payload.account_id },
          })
        } catch (notifErr) {
          console.error(`[JOB] Failed to create notification:`, notifErr.message)
        }
      }
    }

    // â”€â”€â”€ Skip errors â€” mark done with skip result â”€â”€â”€â”€â”€â”€
    if (err.message.startsWith('SKIP_')) {
      if (useApi()) {
        try {
          await api.updateJobStatus(job.id, 'done', {
            result: { skipped: true, reason: err.message },
            error_message: err.message,
          })
        } catch {}
      } else {
        await supabase.from('jobs').update({
          status: 'done',
          result: { skipped: true, reason: err.message },
          finished_at: new Date(),
          error_message: err.message,
        }).eq('id', job.id)
      }
      console.log(`[JOB] Skipped ${job.id}: ${err.message}`)

      // Track consecutive skips per campaign+role â€” prevent infinite loop
      if (err.message === 'SKIP_no_groups_joined' && job.payload?.campaign_id) {
        const skipKey = `${job.payload.campaign_id}_${job.payload.role_id || 'default'}`
        const skipCount = (consecutiveSkips.get(skipKey) || 0) + 1
        consecutiveSkips.set(skipKey, skipCount)

        if (skipCount >= 3) {
          // 3 consecutive skips â†’ notify user + pause this role
          console.warn(`[JOB] âš ï¸ ${skipCount} consecutive skips for campaign role â€” notifying user`)
          try {
            await supabase.from('notifications').insert({
              user_id: job.payload.owner_id || job.created_by,
              title: 'AI Pilot: KhÃ´ng tÃ¬m Ä‘Æ°á»£c nhÃ³m phÃ¹ há»£p',
              body: `Campaign "${job.payload.topic || 'unknown'}" Ä‘Ã£ thá»­ ${skipCount} láº§n nhÆ°ng khÃ´ng tÃ¬m Ä‘Æ°á»£c nhÃ³m nÃ o phÃ¹ há»£p. HÃ£y kiá»ƒm tra topic hoáº·c thÃªm nhÃ³m thá»§ cÃ´ng.`,
              type: 'campaign_warning',
              metadata: { campaign_id: job.payload.campaign_id, role_id: job.payload.role_id },
            })
          } catch {}

          // Pause the role to stop new jobs
          if (job.payload.role_id) {
            await supabase.from('campaign_roles')
              .update({ status: 'paused' })
              .eq('id', job.payload.role_id)
            console.warn(`[JOB] Paused role ${job.payload.role_id} after ${skipCount} consecutive no-group skips`)
          }
          consecutiveSkips.delete(skipKey)
        }
      }
      return
    }

    // â”€â”€â”€ Retry or fail permanently â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const canRetry = isRetryable(classified) && nextAttempt < maxAttempts

    if (canRetry) {
      const retryDelayMs = getRetryDelayMs(classified, nextAttempt - 1)
      const retryAfter = new Date(Date.now() + retryDelayMs)
      if (useApi()) {
        try {
          await api.updateJobStatus(job.id, 'pending', {
            attempt: nextAttempt,
            scheduled_at: retryAfter.toISOString(),
            error_message: `[${classified.type}] ${err.message}`,
          })
        } catch { /* fallback below */ }
      } else {
        await supabase.from('jobs').update({
          status: 'pending',
          attempt: nextAttempt,
          scheduled_at: retryAfter.toISOString(),
          error_message: `[${classified.type}] ${err.message}`
        }).eq('id', job.id)
      }
      console.log(`[JOB] Retry #${nextAttempt} in ${Math.ceil(retryDelayMs / 60000)}min [${classified.type}]`)
    } else {
      const reason = !isRetryable(classified) ? classified.type : `max_attempts (${maxAttempts})`
      if (useApi()) {
        try {
          await api.failJob(job.id, `[${classified.type}] ${err.message}`, nextAttempt)
        } catch { /* fallback below */ }
      } else {
        await supabase.from('jobs').update({
          status: 'failed',
          attempt: nextAttempt,
          error_message: `[${classified.type}] ${err.message}`,
          finished_at: new Date()
        }).eq('id', job.id)
      }
      console.log(`[JOB] Failed permanently: ${reason} (${job.id})`)

      // Notify user on permanent failure (if alert worthy)
      if (classified.alertLevel && job.created_by && !shouldDisableAccount(classified)) {
        try {
          await supabase.from('notifications').insert({
            user_id: job.created_by,
            type: 'job_failed',
            title: `Job ${handlerKey} that bai`,
            body: `Sau ${nextAttempt} lan thu. Loi: ${err.message.slice(0, 200)}`,
            level: classified.alertLevel || 'info',
            data: { job_id: job.id, account_id: job.payload?.account_id },
          })
          if (job.payload?.account_id) {
            await ensureAccountAlert(
              supabase,
              job.payload.account_id,
              'job_failed',
              classified.alertLevel === 'urgent' ? 'critical' : 'warning',
              `Job ${handlerKey} tháº¥t báº¡i: ${err.message.slice(0, 200)}`
            )
          }
        } catch (notifErr) {}
      }
    }
  }
}

async function updateJobStatus(id, status, result = null, error = null) {
  if (useApi()) {
    try {
      const extra = {}
      if (result) extra.result = result
      if (error) extra.error_message = error
      await api.updateJobStatus(id, status, extra)
    } catch (err) {
      console.error(`[JOB] API status update failed (${id} â†’ ${status}): ${err.message}`)
      // Fallback to direct DB
      await supabase.from('jobs').update({
        status,
        ...(result && { result }),
        ...(error && { error_message: error }),
        ...(status === 'done' || status === 'failed' ? { finished_at: new Date() } : {})
      }).eq('id', id)
    }
    return
  }
  await supabase.from('jobs').update({
    status,
    ...(result && { result }),
    ...(error && { error_message: error }),
    ...(status === 'done' || status === 'failed' ? { finished_at: new Date() } : {})
  }).eq('id', id)
}

// Track consecutive stale recovery failures â€” rate-limit the warning log
let _staleRecoveryFailCount = 0
let _lastStaleWarnAt = 0

async function recoverStaleJobs(isStartup = false) {
  if (useApi()) {
    try {
      const result = await api.recoverStaleJobs({ is_startup: isStartup, agent_id: AGENT_ID })
      if (result.recovered > 0) {
        console.log(`[POLLER] Recovered ${result.recovered}/${result.total_stale} stale jobs via API (startup: ${isStartup})`)
      }
      // Reset fail counter on success
      _staleRecoveryFailCount = 0
    } catch (err) {
      // Silent fail â€” don't spam console with error. Warn at most every 10 min
      // when API is consistently unreachable. Transient errors are ignored.
      _staleRecoveryFailCount++
      const now = Date.now()
      if (_staleRecoveryFailCount === 1 || (now - _lastStaleWarnAt > 10 * 60 * 1000)) {
        console.warn(`[POLLER] Stale recovery skipped (${_staleRecoveryFailCount}x): ${err.message}`)
        _lastStaleWarnAt = now
      }
    }
    return
  }

  // Direct DB fallback
  let query = supabase
    .from('jobs')
    .select('id, type, status, started_at, last_heartbeat_at')
    .in('status', ['claimed', 'running'])

  if (isStartup) {
    // LÃºc khá»Ÿi Ä‘á»™ng: Giáº£i phÃ³ng ngay toÃ n bá»™ cÃ¡c job bá»‹ káº¹t cá»§a chÃ­nh AGENT nÃ y
    query = query.eq('agent_id', AGENT_ID)
    console.log(`[POLLER] Khá»Ÿi Ä‘á»™ng: Äang quÃ©t giáº£i phÃ³ng cÃ¡c job bá»‹ káº¹t cá»§a agent ${AGENT_ID}...`)
  } else {
    const staleTime = new Date(Date.now() - 10 * 60 * 1000).toISOString()
    query = query.lt('started_at', staleTime)
  }

  const { data: staleRaw } = await query

  // Job còn heartbeat <10' là ĐANG CHẠY THẬT — không recover (04/09, cùng lý
  // do với TASK-CLEANUP: started_at giờ ghi 1 lần, phiên dài 30-45' hợp lệ).
  const nhipTimCu = Date.now() - 10 * 60 * 1000
  const stale = isStartup ? (staleRaw || []) : (staleRaw || []).filter(j => {
    const beat = j.last_heartbeat_at || j.started_at
    return beat && new Date(beat).getTime() < nhipTimCu
  })

  for (const job of (stale || [])) {
    const nextAttempt = (job.attempt || 0) + 1
    await supabase.from('jobs').update({
      status: 'pending',
      agent_id: null,
      started_at: null,
      scheduled_at: new Date().toISOString(),
      attempt: nextAttempt,
      error_message: 'Agent crashed or timed out, retrying'
    }).eq('id', job.id)
    console.log(`[POLLER] Recovered stale job ${job.type} (${job.id}) - was ${job.status} since ${job.started_at}`)
  }
  if ((stale || []).length > 0) {
    console.log(`[POLLER] Recovered ${stale.length} stale jobs`)
  }
}

// â”€â”€â”€ Opportunity React: pick pending opportunities and create react jobs â”€â”€â”€
async function checkOpportunities() {
  try {
    const { data: opps } = await supabase
      .from('group_opportunities')
      .select('*, monitored_groups(brand_keywords, brand_name, brand_voice, account_id, campaign_id, owner_id)')
      .eq('status', 'pending')
      .gt('expires_at', new Date().toISOString())
      .order('opportunity_score', { ascending: false })
      .limit(5)

    if (!opps?.length) return

    let created = 0
    for (const opp of opps) {
      const mg = opp.monitored_groups
      if (!mg) continue

      // Pick a reactor account DIFFERENT from the scanner
      const scannerAccountId = mg.account_id
      const { data: campaignRoles } = await supabase
        .from('campaign_roles')
        .select('account_ids')
        .eq('campaign_id', mg.campaign_id)
        .eq('is_active', true)

      // Collect all account IDs from campaign roles
      const allAccountIds = [...new Set(
        (campaignRoles || []).flatMap(r => r.account_ids || [])
      )].filter(id => id !== scannerAccountId)

      if (allAccountIds.length === 0) {
        console.log(`[OPP-CHECK] No alternative accounts for opportunity ${opp.id}, skipping`)
        continue
      }

      // Check which accounts are active and old enough (>= 21 days)
      const { data: accounts } = await supabase
        .from('accounts')
        .select('id, created_at, status, is_active')
        .in('id', allAccountIds)
        .eq('is_active', true)
        .eq('status', 'healthy')

      const eligible = (accounts || []).filter(a => {
        const age = Math.floor((Date.now() - new Date(a.created_at).getTime()) / 86400000)
        return age >= 21 // Week 3+ warmup
      })

      if (eligible.length === 0) {
        console.log(`[OPP-CHECK] No eligible reactors for opportunity ${opp.id}`)
        continue
      }

      // Pick random eligible account
      const reactor = eligible[Math.floor(Math.random() * eligible.length)]

      // Check this account hasn't already acted on this post
      const { count: alreadyActed } = await supabase
        .from('group_opportunities')
        .select('id', { count: 'exact', head: true })
        .eq('post_fb_id', opp.post_fb_id)
        .eq('acted_by_account_id', reactor.id)
        .eq('status', 'acted')

      if (alreadyActed > 0) continue

      // Check no duplicate react job
      const { count: dupJob } = await supabase
        .from('jobs')
        .select('id', { count: 'exact', head: true })
        .eq('type', 'campaign_opportunity_react')
        .in('status', ['pending', 'claimed', 'running'])
        .filter('payload->>opportunity_id', 'eq', opp.id)

      if (dupJob > 0) continue

      // Mark opportunity as 'acting' to prevent double-pick
      await supabase.from('group_opportunities')
        .update({ status: 'acting' })
        .eq('id', opp.id)
        .eq('status', 'pending') // optimistic lock

      // Create react job
      const { error } = await supabase.from('jobs').insert({
        type: 'campaign_opportunity_react',
        priority: 5, // NORMAL
        payload: {
          opportunity_id: opp.id,
          account_id: reactor.id,
          campaign_id: mg.campaign_id,
          owner_id: mg.owner_id,
          // Chào hàng = quảng cáo → hưởng cơ chế THA stale 1 lần của
          // job-watchdog VPS (dời +30' thay vì hủy). Thiếu cờ này, 2 job react
          // đầu đời chết stale_pending_timeout lúc 2h sáng 04/09 vì nick nghỉ.
          is_ad: true,
        },
        status: 'pending',
        scheduled_at: new Date(Date.now() + Math.floor(Math.random() * 120 + 30) * 1000).toISOString(), // 30s-2.5min jitter
        created_by: mg.owner_id,
      })

      if (!error) {
        created++
        console.log(`[OPP-CHECK] Created react job for opportunity ${opp.id} (score: ${opp.opportunity_score}) â†’ account ${reactor.id.slice(0, 8)}`)
      }
    }

    if (created > 0) {
      console.log(`[OPP-CHECK] Created ${created} opportunity react jobs`)
    }
  } catch (err) {
    console.error(`[OPP-CHECK] Error: ${err.message}`)
  }
}

// â”€â”€â”€ Phase 3: Shared Post Swarm â€” extend swarm targets for high-score pooled posts â”€â”€â”€
async function checkSharedPostSwarm() {
  try {
    const { data: posts } = await supabase
      .from('shared_posts')
      .select('*')
      .eq('status', 'pending')
      .eq('is_ad_post', false)
      .gt('expires_at', new Date().toISOString())
      .order('ai_score', { ascending: false })
      .limit(10)

    if (!posts?.length) return

    let created = 0
    for (const p of posts) {
      if ((p.swarm_count || 0) >= (p.swarm_target || 1)) continue

      // Find eligible accounts in this campaign that haven't acted on this post yet
      const { data: roles } = await supabase
        .from('campaign_roles')
        .select('account_ids')
        .eq('campaign_id', p.campaign_id)
        .eq('is_active', true)
      const allIds = [...new Set((roles || []).flatMap(r => r.account_ids || []))]
        .filter(id => !(p.swarm_account_ids || []).includes(id))
      if (!allIds.length) continue

      const { data: accounts } = await supabase
        .from('accounts')
        .select('id, created_at')
        .in('id', allIds)
        .eq('is_active', true)
        .eq('status', 'healthy')
      const eligible = (accounts || []).filter(a => {
        const age = Math.floor((Date.now() - new Date(a.created_at).getTime()) / 86400000)
        return age >= 21
      })
      if (!eligible.length) continue

      const reactor = eligible[Math.floor(Math.random() * eligible.length)]

      // Resolve campaign owner_id so that we can insert it in created_by and payload.owner_id
      let ownerId = null
      try {
        const { data: campaign } = await supabase
          .from('campaigns')
          .select('owner_id')
          .eq('id', p.campaign_id)
          .single()
        ownerId = campaign?.owner_id || null
      } catch (err) {
        console.warn(`[SWARM] Failed to get campaign owner: ${err.message}`)
      }

      // Cumulative delay based on swarm_count: nick2 +10-20min, nick3 +25-40min
      const slot = (p.swarm_count || 0) + 1
      const delayMin = slot === 2 ? (10 + Math.random() * 10) : (25 + Math.random() * 15)
      const scheduledAt = new Date(Date.now() + delayMin * 60 * 1000).toISOString()

      const { error } = await supabase.from('jobs').insert({
        type: 'campaign_opportunity_react',
        priority: 5,
        payload: {
          shared_post_id: p.id,
          post_fb_id: p.post_fb_id,
          post_url: p.post_url,
          account_id: reactor.id,
          campaign_id: p.campaign_id,
          comment_angle: p.comment_angle,
          language: p.language,
          owner_id: ownerId,
        },
        status: 'pending',
        scheduled_at: scheduledAt,
        created_by: ownerId,
      })

      if (!error) {
        // Optimistic: claim a swarm slot
        await supabase.from('shared_posts').update({
          swarm_count: (p.swarm_count || 0) + 1,
          swarm_account_ids: [...(p.swarm_account_ids || []), reactor.id],
          status: ((p.swarm_count || 0) + 1) >= (p.swarm_target || 1) ? 'in_progress' : 'pending',
        }).eq('id', p.id)
        created++
        console.log(`[SWARM] Queued react slot ${slot}/${p.swarm_target} for shared_post ${p.id.slice(0,8)} (delay +${Math.round(delayMin)}min)`)
      }
    }
    if (created > 0) console.log(`[SWARM] Created ${created} swarm react jobs`)
  } catch (err) {
    console.error(`[SWARM] Error: ${err.message}`)
  }
}

let _pollIntervalTimeout = null

async function runAdaptivePoll() {
  if (stopPoller._isStopped) return

  let delayMs = POLL_MS
  if (_consecutiveEmptyPolls >= 3) {
    delayMs = 45000 // 45 giÃ¢y náº¿u 3 chu ká»³ liÃªn tiáº¿p trá»‘ng rá»—ng (khÃ´ng cÃ³ job)
  }
  // ThÃªm nhiá»…u Â±25%: nhá»‹p poll Ä‘á»u tÄƒm táº¯p (Ä‘Ãºng 5.000ms má»—i láº§n) lÃ  dáº¥u hiá»‡u
  // mÃ¡y mÃ³c rÃµ rÃ ng á»Ÿ táº§ng lÆ°u lÆ°á»£ng. Ngáº«u nhiÃªn hoÃ¡ cho giá»‘ng ngÆ°á»i dÃ¹ng tháº­t.
  delayMs = Math.round(delayMs * (0.75 + Math.random() * 0.5))

  _pollIntervalTimeout = setTimeout(async () => {
    try {
      const hasJob = await poll()
      if (hasJob) {
        _consecutiveEmptyPolls = 0
      } else {
        _consecutiveEmptyPolls++
      }
    } catch (err) {
      _consecutiveEmptyPolls++
    }
    runAdaptivePoll()
  }, delayMs)
}

function startPoller() {
  const userInfo = AGENT_USER_ID ? ` | user: ${process.env.AGENT_USER_EMAIL || AGENT_USER_ID}` : ''
  const totalGB = (os.totalmem() / 1024 / 1024 / 1024).toFixed(1)
  const freeGB = (os.freemem() / 1024 / 1024 / 1024).toFixed(1)
  const mode = useApi() ? 'REST API' : 'Direct DB'
  console.log(`[POLLER] Starting â€” max ${MAX_CONCURRENT} concurrent nicks (auto-scale, ${freeGB}/${totalGB}GB RAM), mode: ${mode}${userInfo}`)
  
  stopPoller._isStopped = false
  recoverStaleJobs(true).then(() => {
    runAdaptivePoll()
  })
  const recoverInterval = setInterval(recoverStaleJobs, 2 * 60 * 1000)

  // â”€â”€ Group Opportunity React: check pending opportunities every 5 min â”€â”€
  const opportunityInterval = setInterval(() => {
    checkOpportunities().catch(err => console.warn(`[OPP-CHECK] Error: ${err.message}`))
    checkSharedPostSwarm().catch(err => console.warn(`[SWARM] Error: ${err.message}`))
  }, 5 * 60 * 1000)

  // â”€â”€ Idle nick auto-assign: every 5 min, find healthy nicks with no recent jobs
  //    but assigned to a running campaign_role â†’ queue a task for them.
  const idleAssignInterval = setInterval(async () => {
    try {
      const axios = require('axios')
      const API_URL = process.env.API_URL || _pollerCfg.API_URL || 'http://localhost:3000'
      const AGENT_SECRET = process.env.AGENT_SECRET || process.env.AGENT_SECRET_KEY || _pollerCfg.AGENT_SECRET_KEY
      if (!AGENT_SECRET) return // only works when REST-API auth is set
      const headers = { 'X-Agent-Key': AGENT_SECRET }
      const { data } = await axios.get(`${API_URL}/accounts/idle-assignable`, { headers, timeout: 10000 })
      const list = Array.isArray(data) ? data : []
      for (const nick of list) {
        try {
          // Activate via API â€” will mark healthy + queue appropriate job
          await axios.post(`${API_URL}/accounts/${nick.id}/activate`, {}, { headers, timeout: 10000 })
          console.log(`[POLLER] Auto-assigned job to idle nick: ${nick.username} (role: ${nick.role})`)
        } catch (e) {
          // activate may 404 if nick needs JWT auth â€” silent skip
        }
      }
    } catch (err) {
      // Silent â€” /idle-assignable may not exist on older API; rate-limit log
      if (!poller_idleAssignWarned) {
        console.warn(`[POLLER] Idle auto-assign skipped: ${err.message}`)
        poller_idleAssignWarned = true
        setTimeout(() => { poller_idleAssignWarned = false }, 10 * 60 * 1000)
      }
    }
  }, 5 * 60 * 1000)

  // â”€â”€ Realtime: instant job pickup â”€â”€
  let realtimeChannel = null
  const { config: _dbConfig } = require('../lib/db')
  const _useVpsProxy = !!(process.env.DATABASE_URL || _dbConfig?.DATABASE_URL || _dbConfig?.API_URL || process.env.API_URL)
  if (_useVpsProxy) {
    // VPS mode (direct PG or HTTP proxy): polling every 5s is fast enough, no Realtime needed
    console.log('[POLLER] Polling mode only (VPS mode, no realtime)')
  } else {
    // (legacy Realtime path â€” VPS mode dÃ¹ng polling, xem nhÃ¡nh _useVpsProxy á»Ÿ trÃªn)
    try {
      realtimeChannel = supabase
        .channel('jobs-realtime')
        .on('postgres_changes', {
          event: 'INSERT',
          schema: 'public',
          table: 'jobs',
          filter: 'status=eq.pending',
        }, (payload) => {
          const jobType = payload.new?.type || '?'
          console.log(`[REALTIME] New job: ${jobType} â€” triggering immediate poll`)
          if (Date.now() - _lastPollAt < 2000) return
          poll()
        })
        .subscribe((status) => {
          if (status === 'SUBSCRIBED') {
            console.log('[REALTIME] âœ“ Subscribed to jobs table â€” instant pickup enabled')
          } else if (status === 'CHANNEL_ERROR') {
            console.warn('[REALTIME] âš ï¸ Channel error â€” falling back to polling only')
          }
        })
    } catch (err) {
      console.warn(`[REALTIME] Failed to subscribe: ${err.message} â€” polling only`)
    }
  }

  // Export stop function for agent.js shutdown handler
  stopPoller = async () => {
    console.log('[POLLER] Stopping...')
    stopPoller._isStopped = true
    if (_pollIntervalTimeout) clearTimeout(_pollIntervalTimeout)
    clearInterval(recoverInterval)
    clearInterval(opportunityInterval)
    clearInterval(idleAssignInterval)
    if (realtimeChannel) {
      try { await supabase.removeChannel(realtimeChannel) } catch {}
    }
    await closeAll()
    // Flush pending health signals
    try { const { stopCollector } = require('../lib/signal-collector'); await stopCollector() } catch {}
    console.log('[POLLER] Stopped, browser sessions closed')
  }
}

let stopPoller = async () => {} // set by startPoller

function getPool() { return pool }

// â”€â”€â”€ Per-nick account status check â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function checkAccountActive(accountId) {
  try {
    const cached = accountStatusCache.get(accountId)
    if (cached && Date.now() - cached.fetchedAt < STATUS_CACHE_TTL) {
      return cached.status !== 'expired' && cached.status !== 'checkpoint'
    }
    const { data } = await supabase
      .from('accounts')
      .select('is_active, status, agent_enabled, created_at, fb_created_at, active_hours_start, active_hours_end')
      .eq('id', accountId)
      .single()
    if (data) {
      accountStatusCache.set(accountId, { ...data, fetchedAt: Date.now() })
      return data.status !== 'expired' && data.status !== 'checkpoint'
    }
    return true // account not found â€” let handler deal with it
  } catch {
    return true
  }
}

// â”€â”€â”€ Per-nick budget pre-check â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function checkBudgetBeforeClaim(accountId, actionType) {
  try {
    const cached = nickBudgetCache.get(accountId)
    let budget = cached?.budget

    if (!cached || Date.now() - cached.fetchedAt >= BUDGET_CACHE_TTL) {
      const { data } = await supabase
        .from('accounts')
        .select('daily_budget')
        .eq('id', accountId)
        .single()
      budget = data?.daily_budget || {}
      nickBudgetCache.set(accountId, { budget, fetchedAt: Date.now() })
    }

    // Check if budget needs daily reset (reset_at is before today VN timezone)
    const resetAt = budget?.reset_at
    if (resetAt) {
      const vnNow = new Date(Date.now() + 7 * 3600 * 1000) // UTC+7
      const vnToday = vnNow.toISOString().slice(0, 10)
      const resetDate = new Date(new Date(resetAt).getTime() + 7 * 3600 * 1000).toISOString().slice(0, 10)

      if (resetDate < vnToday) {
        // Budget is stale â€” trigger reset by calling increment_budget with 0
        console.log(`[POLLER] Budget stale for ${accountId.slice(0, 8)} (reset_at=${resetDate}, today=${vnToday}) â€” triggering reset`)
        try {
          await supabase.rpc('increment_budget', { p_account_id: accountId, p_action_type: actionType, p_count: 0 })
          // Invalidate cache to fetch fresh reset budget
          nickBudgetCache.delete(accountId)
          // Clear log suppression
          for (const key of nickBudgetExhaustedLog) {
            if (key.startsWith(`budget_log:${accountId}:`)) nickBudgetExhaustedLog.delete(key)
          }
          return true // budget just reset, allow
        } catch (resetErr) {
          console.warn(`[POLLER] Budget reset RPC failed: ${resetErr.message}`)
        }
      }
    }

    const cat = budget?.[actionType]
    if (cat && cat.used >= cat.max) return false
    return true
  } catch {
    return true // on error, allow the job (handler will check again)
  }
}

// Phase 16: group isolation â€” handlers call this after visiting a group
function recordGroupVisit(fbGroupId, nickId) {
  if (!fbGroupId || !nickId) return
  const visits = groupVisitLog.get(fbGroupId) || []
  visits.push({ nickId, ts: Date.now() })
  groupVisitLog.set(fbGroupId, visits)
}

function canVisitGroup(fbGroupId, nickId) {
  if (!fbGroupId) return true
  const visits = (groupVisitLog.get(fbGroupId) || []).filter(v => Date.now() - v.ts < 30 * 60 * 1000)
  const uniqueNicks = new Set(visits.map(v => v.nickId))
  if (uniqueNicks.has(nickId)) return true // this nick already visited â†’ ok
  return uniqueNicks.size < 2 // max 2 different nicks per 30min
}

async function ensureAccountAlert(supabase, accountId, type, severity, message) {
  try {
    const { data: existingAlert } = await supabase.from('account_alerts')
      .select('id')
      .eq('account_id', accountId)
      .eq('status', 'open')
      .eq('type', type)
      .limit(1)

    if (!existingAlert || existingAlert.length === 0) {
      const { data: acct } = await supabase.from('accounts').select('username').eq('id', accountId).single()
      const username = acct?.username || accountId.slice(0, 8)
      await supabase.from('account_alerts').insert({
        account_id: accountId,
        type: type,
        severity: severity,
        message: `TÃ i khoáº£n ${username}: ${message}`,
        status: 'open',
        created_at: new Date().toISOString()
      })
      console.log(`[ALERT] Created direct account alert for ${username} [${type}]`)
    }
  } catch (alertErr) {
    console.warn(`[ALERT] Failed to insert account alert: ${alertErr.message}`)
  }
}

module.exports = { startPoller, getStopPoller: () => stopPoller, getPool, recordGroupVisit, canVisitGroup, ensureAccountAlert }
