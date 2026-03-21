const { supabase } = require('../lib/supabase')
const handlers = require('./handlers')
const os = require('os')
const { closeAll } = require('../browser/session-pool')

const AGENT_ID = process.env.AGENT_ID || `${os.hostname()}-${process.pid}`
const AGENT_USER_ID = process.env.AGENT_USER_ID || null  // set when user logs in via Electron
const POLL_MS = 5000
// Non-posting jobs (video processing, health check, etc.) có thể chạy song song
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT) || 5

// Browser jobs chạy tuần tự (1 job/lượt) để tránh conflict session
// Graph API jobs (post_page_graph) không cần cooldown vì là API call trực tiếp
const POST_TYPES = ['post_page', 'post_page_graph', 'post_group', 'post_profile']
const BROWSER_TYPES = [...POST_TYPES, 'fetch_source_cookie', 'comment_post', 'scan_group_keyword']
const GRAPH_API_TYPES = ['post_page_graph'] // No cooldown needed
// Nghỉ ngẫu nhiên giữa các bài đăng (phút)
// Env: POST_DELAY_MIN (default 2), POST_DELAY_MAX (default 5)
const POST_DELAY_MIN = parseFloat(process.env.POST_DELAY_MIN) || 2
const POST_DELAY_MAX = parseFloat(process.env.POST_DELAY_MAX) || 5

const running = new Set()
let isPostingActive = false // chỉ 1 posting job chạy tại 1 thời điểm
let lastPostFinishedAt = 0  // timestamp khi bài đăng cuối hoàn thành
let currentCooldownMs = 0   // cooldown ngẫu nhiên được chọn sau mỗi bài
let pollFails = 0           // track consecutive poll failures

// Random delay trong khoảng [min, max] phút → ms
function randomPostDelay() {
  const minutes = POST_DELAY_MIN + Math.random() * (POST_DELAY_MAX - POST_DELAY_MIN)
  return Math.round(minutes * 60 * 1000)
}

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
  if (running.size >= MAX_CONCURRENT) return

  try {
    const excludedUserIds = await getExcludedUserIds()

    let query = supabase
      .from('jobs')
      .select('*')
      .eq('status', 'pending')
      .lte('scheduled_at', new Date().toISOString())
      .order('scheduled_at', { ascending: true })
      .limit(MAX_CONCURRENT - running.size)

    // Use preference-based routing — skip jobs from users who prefer a different executor
    if (excludedUserIds.length > 0) {
      query = query.not('created_by', 'in', `(${excludedUserIds.join(',')})`)
    }

    const { data: jobs } = await query

    for (const job of (jobs || [])) {
      const isPostJob = POST_TYPES.includes(job.type)
      const isBrowserJob = BROWSER_TYPES.includes(job.type)
      const isGraphApi = GRAPH_API_TYPES.includes(job.type)

      // Browser jobs (posting + fetch + comment + scan): chỉ 1 job dùng browser tại 1 thời điểm
      if (isBrowserJob && !isGraphApi) {
        if (isPostingActive) continue

        // Post jobs: phải nghỉ ngẫu nhiên giữa các bài
        if (isPostJob) {
          const timeSinceLastPost = Date.now() - lastPostFinishedAt
          if (lastPostFinishedAt > 0 && timeSinceLastPost < currentCooldownMs) {
            const waitSec = Math.ceil((currentCooldownMs - timeSinceLastPost) / 1000)
            console.log(`[POLLER] Post cooldown: waiting ${waitSec}s (${(currentCooldownMs / 60000).toFixed(1)}min total)`)
            continue
          }
        }
      }

      // Claim job
      const { error } = await supabase.from('jobs')
        .update({ status: 'claimed', agent_id: AGENT_ID, started_at: new Date() })
        .eq('id', job.id)
        .eq('status', 'pending')

      if (error) continue

      running.add(job.id)
      if (isBrowserJob && !isGraphApi) isPostingActive = true

      console.log(`[JOB] Claimed ${job.type} (${job.id})${isBrowserJob ? ' [BROWSER - sequential]' : ''}`)

      executeJob(job).finally(() => {
        running.delete(job.id)
        if (isBrowserJob && !isGraphApi) {
          isPostingActive = false
          if (isPostJob) {
            lastPostFinishedAt = Date.now()
            currentCooldownMs = randomPostDelay()
            const cooldownMin = (currentCooldownMs / 60000).toFixed(1)
            console.log(`[POLLER] Browser post finished, next cooldown: ${cooldownMin}min (random ${POST_DELAY_MIN}-${POST_DELAY_MAX}min)`)
          } else {
            console.log(`[POLLER] Browser job finished (${job.type}), ready for next`)
          }
        }
        if (isGraphApi) {
          console.log(`[POLLER] Graph API post finished, no cooldown needed`)
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
  // Reset on success
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
    const result = await handler(job.payload, supabase)
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
  } catch (err) {
    console.error(`[JOB] Error ${handlerKey} (${job.id}):`, err.message)

    const maxAttempts = job.max_attempts || 3
    const nextAttempt = (job.attempt || 0) + 1

    // Skip errors — don't retry, mark as done with skip result
    if (err.message.startsWith('SKIP_')) {
      await supabase.from('jobs').update({
        status: 'done',
        result: { skipped: true, reason: err.message },
        finished_at: new Date(),
        error_message: err.message,
      }).eq('id', job.id)
      console.log(`[JOB] Skipped ${job.id}: ${err.message}`)
      return
    }

    if (nextAttempt < maxAttempts) {
      // Retry nhanh hơn: 30s, 60s, 90s... thay vì 5min, 10min
      const retryDelaySec = Math.min(nextAttempt * 30, 120) // max 2 phút
      const retryAfter = new Date(Date.now() + retryDelaySec * 1000)
      await supabase.from('jobs').update({
        status: 'pending',
        attempt: nextAttempt,
        scheduled_at: retryAfter.toISOString(),
        error_message: err.message
      }).eq('id', job.id)
      console.log(`[JOB] Retry #${nextAttempt} scheduled for ${job.id} (in ${retryDelaySec}s)`)
    } else {
      const finalMsg = `Max attempts reached (${maxAttempts}). User action required. Last error: ${err.message}`
      await supabase.from('jobs').update({
        status: 'failed',
        attempt: nextAttempt,
        error_message: finalMsg,
        finished_at: new Date()
      }).eq('id', job.id)
      console.log(`[JOB] Failed permanently after ${maxAttempts} attempts (${job.id})`)
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
  console.log(`[POLLER] Starting — posting: sequential, delay: ${POST_DELAY_MIN}-${POST_DELAY_MAX}min (random), other jobs: max ${MAX_CONCURRENT} concurrent${userInfo}`)
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

module.exports = { startPoller, getStopPoller: () => stopPoller }
