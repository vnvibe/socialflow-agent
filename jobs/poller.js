const { supabase } = require('../lib/supabase')
const handlers = require('./handlers')
const os = require('os')
const { closeAll } = require('../browser/session-pool')
const { classifyError, shouldDisableAccount, isRetryable, getRetryDelayMs } = require('../lib/error-classifier')
const { postCooldown } = require('../lib/randomizer')
const { getMinGapMs } = require('../lib/hard-limits')

const AGENT_ID = process.env.AGENT_ID || `${os.hostname()}-${process.pid}`
const AGENT_USER_ID = process.env.AGENT_USER_ID || null  // set when user logs in via Electron
const POLL_MS = 5000
const MEM_PER_NICK_MB = 350 // ~350MB per Chromium instance
const MIN_CONCURRENT = 2
const MAX_CONCURRENT_CAP = 8 // never exceed this even with tons of RAM

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

let MAX_CONCURRENT = calcMaxConcurrent()
// Re-calculate every 2 minutes (RAM changes as browsers open/close)
setInterval(() => {
  const prev = MAX_CONCURRENT
  MAX_CONCURRENT = calcMaxConcurrent()
  if (MAX_CONCURRENT !== prev) {
    console.log(`[POLLER] Auto-scale: ${prev} → ${MAX_CONCURRENT} concurrent nicks (${Math.round(os.freemem() / 1024 / 1024)}MB free)`)
  }
}, 120000)

const POST_TYPES = ['post_page', 'post_page_graph', 'post_group', 'post_profile', 'campaign_post']

// Utility jobs don't occupy a nick slot — they can run alongside interaction jobs
const UTILITY_TYPES = ['fetch_source_cookie', 'fetch_all', 'fetch_pages', 'fetch_groups', 'check_health', 'check_engagement', 'resolve_group', 'scan_group_feed', 'scan_group_keyword', 'watch_my_posts']

// ─── NickPool — auto-scaled concurrent nicks ─────────────
class NickPool {
  constructor() {
    this.interactionNicks = new Set()  // account_ids doing interaction work
    this.utilityNicks = new Set()      // account_ids doing utility work (don't count toward limit)
    this.runningJobs = new Set()       // job_ids currently running
    this.jobsToday = 0
    this.jobsFailed = 0
  }
  // Only interaction nicks count toward concurrent limit
  isBusy()         { return this.interactionNicks.size >= MAX_CONCURRENT }
  // Nick is busy for interaction if doing interaction work
  isRunningInteraction(accId) { return this.interactionNicks.has(accId) }
  // Nick is busy for anything (interaction OR utility using browser)
  isRunning(accId) { return this.interactionNicks.has(accId) || this.utilityNicks.has(accId) }
  acquire(accId, jobId, jobType) {
    if (UTILITY_TYPES.includes(jobType)) {
      this.utilityNicks.add(accId)
    } else {
      this.interactionNicks.add(accId)
    }
    this.runningJobs.add(jobId)
  }
  release(accId, jobId) {
    this.interactionNicks.delete(accId)
    this.utilityNicks.delete(accId)
    this.runningJobs.delete(jobId)
    this.jobsToday++
  }
  fail(accId, jobId) {
    this.interactionNicks.delete(accId)
    this.utilityNicks.delete(accId)
    this.runningJobs.delete(jobId)
    this.jobsFailed++
  }
  get size() { return this.interactionNicks.size + this.utilityNicks.size }
}
const pool = new NickPool()

// ─── Per-nick isolation tracking ─────────────────────────
const nickCooldowns = new Map()        // account_id → { lastPostAt, cooldownMs }
const nickBudgetCache = new Map()      // account_id → { budget, fetchedAt }
const nickActionTimestamps = new Map()
const consecutiveSkips = new Map()     // `campaignId_roleId` → skip count (reset on success) // `${accId}:${actionType}` → lastActionAt
const nickHourlyActions = new Map()    // account_id → { count, resetAt }
const accountStatusCache = new Map()   // account_id → { is_active, status, fetchedAt }
const nickSessionStart = new Map()     // account_id → timestamp when session started
const nickRestUntil = new Map()        // account_id → { until, durationMin }
const BUDGET_CACHE_TTL = 60000         // 1 min
const STATUS_CACHE_TTL = 60000         // 1 min
const MAX_HOURLY_ACTIONS = 50          // cumulative across all types
// Randomized ranges — avoid fixed patterns that FB can detect
const randBetween = (min, max) => Math.floor(min + Math.random() * (max - min))
const randSessionMax = () => randBetween(25, 45) * 60 * 1000   // 25-45 min
const randRestMs = () => randBetween(45, 120) * 60 * 1000      // 45-120 min

const JOB_ACTION_MAP = {
  post_page: 'post', post_page_graph: 'post', post_group: 'post', post_profile: 'post',
  campaign_post: 'post', campaign_nurture: 'like', campaign_discover_groups: 'join_group',
  campaign_send_friend_request: 'friend_request', campaign_interact_profile: 'like',
  campaign_scan_members: 'scan', comment_post: 'comment',
}

let pollFails = 0

// Cache user preferences to avoid querying on every poll
let preferenceCache = { data: [], fetchedAt: 0 }
const PREF_CACHE_TTL = 30000 // 30s

async function getExcludedUserIds() {
  const now = Date.now()
  if (now - preferenceCache.fetchedAt < PREF_CACHE_TTL) return preferenceCache.data

  // Users who have a preferred_executor_id that is NOT this agent → exclude them
  const { data: profiles } = await supabase
    .from('profiles')
    .select('id, preferred_executor_id')
    .not('preferred_executor_id', 'is', null)
    .neq('preferred_executor_id', AGENT_ID)

  preferenceCache = { data: (profiles || []).map(p => p.id), fetchedAt: now }
  return preferenceCache.data
}

async function poll() {
  if (pool.isBusy()) return  // all interaction slots taken

  try {
    const slots = MAX_CONCURRENT - pool.interactionNicks.size
    let query = supabase
      .from('jobs')
      .select('*')
      .eq('status', 'pending')
      .lte('scheduled_at', new Date().toISOString())
      .order('scheduled_at', { ascending: true })
      .limit(slots)

    if (AGENT_USER_ID) {
      query = query.or(`created_by.eq.${AGENT_USER_ID},created_by.is.null`)
    } else {
      const excludedUserIds = await getExcludedUserIds()
      if (excludedUserIds.length > 0) {
        query = query.not('created_by', 'in', `(${excludedUserIds.join(',')})`)
      }
    }

    const { data: jobs } = await query
    if (!jobs?.length) return

    for (const job of jobs) {
      const accId = job.payload?.account_id
      const isPostJob = POST_TYPES.includes(job.type)

      // Skip if this nick is already doing interaction work
      // Utility jobs can run alongside (different browser tab)
      const isUtility = UTILITY_TYPES.includes(job.type)
      if (accId) {
        if (isUtility && pool.isRunning(accId)) continue  // utility: skip if nick has ANY job
        if (!isUtility && pool.isRunningInteraction(accId)) continue  // interaction: skip only if doing interaction
      }

      // Per-nick post cooldown (not global — each nick tracks independently)
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

      // Per-nick account status check (skip disabled/checkpoint/expired accounts)
      if (accId) {
        const statusOk = await checkAccountActive(accId)
        if (!statusOk) {
          console.log(`[POLLER] Nick ${accId.slice(0,8)} not active, skipping job ${job.id}`)
          continue
        }
      }

      // Per-nick hourly rate limit (max 50 actions/hour across all types)
      if (accId) {
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

      // Per-nick rest period (45-120min random gap)
      if (accId) {
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
      }

      // Per-nick budget pre-check (avoid claiming if daily limit already reached)
      if (actionType && accId) {
        const budgetOk = await checkBudgetBeforeClaim(accId, actionType)
        if (!budgetOk) {
          console.log(`[POLLER] Nick ${accId.slice(0,8)} budget exhausted for ${actionType}, skipping`)
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

      // Claim job in DB (atomic via WHERE status='pending')
      const { error } = await supabase.from('jobs')
        .update({ status: 'claimed', agent_id: AGENT_ID, started_at: new Date() })
        .eq('id', job.id)
        .eq('status', 'pending')

      if (error) {
        // Another agent claimed it — release pool slot
        if (accId) pool.release(accId, job.id)
        continue
      }

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
      }

      console.log(`[JOB] Claimed ${job.type} (${job.id}) [${pool.interactionNicks.size}/${MAX_CONCURRENT} interaction${pool.utilityNicks.size ? ` +${pool.utilityNicks.size} utility` : ''}]`)

      // Fire & forget — don't await, allows concurrent execution
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

        // Invalidate budget cache so next poll fetches fresh
        if (accId) nickBudgetCache.delete(accId)

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
              console.log(`[POLLER] Nick ${accId.slice(0,8)} → rest ${restMin}min (after ${durationMin}min work)`)
            } else if (isInteraction && durationMin < 1) {
              console.log(`[POLLER] Nick ${accId.slice(0,8)} → no rest (session was ${durationMin}min, skipped/failed)`)
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
    return
  }
  if (pollFails > 0) {
    console.log(`[POLLER] Reconnected after ${pollFails} poll failures`)
    pollFails = 0
  }
}

async function executeJob(job) {
  // Use payload.action for routing if available, otherwise fall back to job.type
  // This allows using allowed DB types (like check_health) while routing to specific handlers
  const handlerKey = job.payload?.action || job.type
  const handler = handlers[handlerKey]
  if (!handler) {
    console.error(`[JOB] No handler for: ${handlerKey} (type: ${job.type})`)
    await updateJobStatus(job.id, 'failed', null, `Handler not found: ${handlerKey}`)
    return
  }

  try {
    await updateJobStatus(job.id, 'running')
    console.log(`[JOB] Running ${handlerKey} (${job.id})`)

    // Check campaign still active (for campaign jobs only)
    if (job.payload?.campaign_id && handlerKey.startsWith('campaign_')) {
      const { data: camp } = await supabase.from('campaigns')
        .select('status').eq('id', job.payload.campaign_id).single()
      if (camp && !['active', 'running'].includes(camp.status)) {
        console.log(`[JOB] Campaign ${job.payload.campaign_id} is ${camp.status}, skipping job`)
        await updateJobStatus(job.id, 'done', { skipped: true, reason: `campaign_${camp.status}` })
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
      await updateJobStatus(job.id, 'cancelled')
      return
    }

    await updateJobStatus(job.id, 'done', result)
    console.log(`[JOB] Done ${handlerKey} (${job.id})`)

    // Reset consecutive skip counter on success
    if (job.payload?.campaign_id) {
      const skipKey = `${job.payload.campaign_id}_${job.payload.role_id || 'default'}`
      consecutiveSkips.delete(skipKey)
    }
  } catch (err) {
    const classified = classifyError(err.message)
    console.error(`[JOB] Error ${handlerKey} (${job.id}) [${classified.type}]:`, err.message)

    const maxAttempts = job.max_attempts || 3
    const nextAttempt = (job.attempt || 0) + 1

    // ─── Save to job_failures table ────────────────────
    try {
      await supabase.from('job_failures').insert({
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
          ? new Date(Date.now() + getRetryDelayMs(classified, nextAttempt - 1)) : null,
      })
    } catch (insertErr) {
      console.error(`[JOB] Failed to save job_failure:`, insertErr.message)
    }

    // ─── Update account status if needed ───────────────
    if (shouldDisableAccount(classified) && job.payload?.account_id) {
      const newStatus = classified.newStatus || 'checkpoint'
      await supabase.from('accounts')
        .update({ status: newStatus, is_active: false })
        .eq('id', job.payload.account_id)
      console.log(`[JOB] Account ${job.payload.account_id} marked as ${newStatus}`)
      // Invalidate status cache immediately
      accountStatusCache.delete(job.payload.account_id)

      // Auto-queue health check to try refreshing cookie (only for SESSION_EXPIRED, not CHECKPOINT)
      if (classified.type === 'SESSION_EXPIRED') {
        try {
          const { data: existing } = await supabase.from('jobs')
            .select('id')
            .eq('type', 'check-health')
            .eq('payload->>account_id', job.payload.account_id)
            .in('status', ['pending', 'claimed', 'running'])
            .limit(1)
          if (!existing?.length) {
            await supabase.from('jobs').insert({
              type: 'check-health',
              payload: { account_id: job.payload.account_id, action: 'check-health', auto_refresh: true },
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

    // ─── Skip errors — mark done with skip result ──────
    if (err.message.startsWith('SKIP_')) {
      await supabase.from('jobs').update({
        status: 'done',
        result: { skipped: true, reason: err.message },
        finished_at: new Date(),
        error_message: err.message,
      }).eq('id', job.id)
      console.log(`[JOB] Skipped ${job.id}: ${err.message}`)

      // Track consecutive skips per campaign+role — prevent infinite loop
      if (err.message === 'SKIP_no_groups_joined' && job.payload?.campaign_id) {
        const skipKey = `${job.payload.campaign_id}_${job.payload.role_id || 'default'}`
        const skipCount = (consecutiveSkips.get(skipKey) || 0) + 1
        consecutiveSkips.set(skipKey, skipCount)

        if (skipCount >= 3) {
          // 3 consecutive skips → notify user + pause this role
          console.warn(`[JOB] ⚠️ ${skipCount} consecutive skips for campaign role — notifying user`)
          try {
            await supabase.from('notifications').insert({
              user_id: job.payload.owner_id || job.created_by,
              title: 'AI Pilot: Không tìm được nhóm phù hợp',
              body: `Campaign "${job.payload.topic || 'unknown'}" đã thử ${skipCount} lần nhưng không tìm được nhóm nào phù hợp. Hãy kiểm tra topic hoặc thêm nhóm thủ công.`,
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

    // ─── Retry or fail permanently ─────────────────────
    const canRetry = isRetryable(classified) && nextAttempt < maxAttempts

    if (canRetry) {
      const retryDelayMs = getRetryDelayMs(classified, nextAttempt - 1)
      const retryAfter = new Date(Date.now() + retryDelayMs)
      await supabase.from('jobs').update({
        status: 'pending',
        attempt: nextAttempt,
        scheduled_at: retryAfter.toISOString(),
        error_message: `[${classified.type}] ${err.message}`
      }).eq('id', job.id)
      console.log(`[JOB] Retry #${nextAttempt} in ${Math.ceil(retryDelayMs / 60000)}min [${classified.type}]`)
    } else {
      const reason = !isRetryable(classified) ? classified.type : `max_attempts (${maxAttempts})`
      await supabase.from('jobs').update({
        status: 'failed',
        attempt: nextAttempt,
        error_message: `[${classified.type}] ${err.message}`,
        finished_at: new Date()
      }).eq('id', job.id)
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
        } catch (notifErr) {}
      }
    }
  }
}

async function updateJobStatus(id, status, result = null, error = null) {
  await supabase.from('jobs').update({
    status,
    ...(result && { result }),
    ...(error && { error_message: error }),
    ...(status === 'done' || status === 'failed' ? { finished_at: new Date() } : {})
  }).eq('id', id)
}

async function recoverStaleJobs() {
  // Reset jobs stuck in 'claimed' or 'running' for > 10 minutes (agent likely crashed)
  const staleTime = new Date(Date.now() - 10 * 60 * 1000).toISOString()
  const { data: stale } = await supabase
    .from('jobs')
    .select('id, type, status, started_at')
    .in('status', ['claimed', 'running'])
    .lt('started_at', staleTime)

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

function startPoller() {
  const userInfo = AGENT_USER_ID ? ` | user: ${process.env.AGENT_USER_EMAIL || AGENT_USER_ID}` : ''
  const totalGB = (os.totalmem() / 1024 / 1024 / 1024).toFixed(1)
  const freeGB = (os.freemem() / 1024 / 1024 / 1024).toFixed(1)
  console.log(`[POLLER] Starting — max ${MAX_CONCURRENT} concurrent nicks (auto-scale, ${freeGB}/${totalGB}GB RAM), error-classified retry${userInfo}`)
  recoverStaleJobs().then(() => poll())
  const pollInterval = setInterval(poll, POLL_MS)
  // Periodically recover stale jobs (every 2 minutes)
  const recoverInterval = setInterval(recoverStaleJobs, 2 * 60 * 1000)

  // Export stop function for agent.js shutdown handler
  stopPoller = async () => {
    console.log('[POLLER] Stopping...')
    clearInterval(pollInterval)
    clearInterval(recoverInterval)
    await closeAll()
    console.log('[POLLER] Stopped, browser sessions closed')
  }
}

let stopPoller = async () => {} // set by startPoller

function getPool() { return pool }

// ─── Per-nick account status check ──────────────────────
async function checkAccountActive(accountId) {
  try {
    const cached = accountStatusCache.get(accountId)
    if (cached && Date.now() - cached.fetchedAt < STATUS_CACHE_TTL) {
      return cached.is_active === true
    }
    const { data } = await supabase
      .from('accounts')
      .select('is_active, status')
      .eq('id', accountId)
      .single()
    if (data) {
      accountStatusCache.set(accountId, { ...data, fetchedAt: Date.now() })
      return data.is_active === true
    }
    return true // account not found — let handler deal with it
  } catch {
    return true
  }
}

// ─── Per-nick budget pre-check ───────────────────────────
async function checkBudgetBeforeClaim(accountId, actionType) {
  try {
    const cached = nickBudgetCache.get(accountId)
    if (cached && Date.now() - cached.fetchedAt < BUDGET_CACHE_TTL) {
      const cat = cached.budget?.[actionType]
      if (cat && cat.used >= cat.max) return false
      return true
    }

    const { data } = await supabase
      .from('accounts')
      .select('daily_budget')
      .eq('id', accountId)
      .single()

    if (data) {
      nickBudgetCache.set(accountId, { budget: data.daily_budget || {}, fetchedAt: Date.now() })
      const cat = data.daily_budget?.[actionType]
      if (cat && cat.used >= cat.max) return false
    }
    return true
  } catch {
    return true // on error, allow the job (handler will check again)
  }
}

module.exports = { startPoller, getStopPoller: () => stopPoller, getPool }
