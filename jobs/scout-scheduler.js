/**
 * Scout Scheduler — Tự động tạo job scan_group cho các nhóm đến hạn quét
 *
 * Multi-tenant:
 * - Khi AGENT_USER_ID set (Electron mode): chỉ quét targets của user đó
 * - Khi AGENT_USER_ID null (VPS mode): quét ALL targets, group by user_id
 */

const SCOUT_POLL_MS =
  (parseInt(process.env.SCOUT_POLL_MINUTES) || 30) * 60 * 1000 // default 30 phút
const INITIAL_DELAY_MS = 10 * 1000 // chờ 10s sau khi agent start

let _interval = null
let _timeout = null

async function runScoutScheduler(supabase) {
  const AGENT_USER_ID = process.env.AGENT_USER_ID || null

  try {
    // 1. Query scout_targets đang active
    let query = supabase
      .from('scout_targets')
      .select('*')
      .eq('is_active', true)

    if (AGENT_USER_ID) {
      query = query.eq('user_id', AGENT_USER_ID)
    }

    const { data: targets, error } = await query
    if (error) {
      console.warn(`[SCOUT-SCHEDULER] Query targets failed: ${error.message}`)
      return
    }
    if (!targets || targets.length === 0) return

    console.log(
      `[SCOUT-SCHEDULER] Checking ${targets.length} active target(s)...`
    )

    let jobsCreated = 0

    for (const target of targets) {
      try {
        // 2. Check if target is due for scan
        if (target.last_scanned_at) {
          const lastScanned = new Date(target.last_scanned_at).getTime()
          const intervalMs = (target.scan_interval_hours || 6) * 3600 * 1000
          if (Date.now() - lastScanned < intervalMs) {
            continue // not due yet
          }
        }

        // 3. Check no pending/running job exists for this target
        const { data: existingJobs } = await supabase
          .from('jobs')
          .select('id')
          .eq('type', 'scan_group')
          .in('status', ['pending', 'running', 'claimed'])
          .filter('payload->>scout_target_id', 'eq', target.id)
          .limit(1)

        if (existingJobs && existingJobs.length > 0) {
          console.log(
            `[SCOUT-SCHEDULER] Skip target ${target.name || target.fb_group_id} — job already pending/running`
          )
          continue
        }

        // 4. Get active accounts
        const { data: accounts } = await supabase
          .from('accounts')
          .select('id, username, last_used_at')
          .eq('is_active', true)

        if (!accounts || accounts.length === 0) {
          console.log(
            `[SCOUT-SCHEDULER] Skip target ${target.name || target.fb_group_id} — no active FB accounts found`
          )
          continue
        }

        // 5. Pick account — least recently used (simple rotation)
        accounts.sort((a, b) => {
          const aTime = a.last_used_at
            ? new Date(a.last_used_at).getTime()
            : 0
          const bTime = b.last_used_at
            ? new Date(b.last_used_at).getTime()
            : 0
          return aTime - bTime
        })
        const chosenAccount = accounts[0]

        // 6. Create scan_group job
        const jobPayload = {
          user_id: target.user_id,
          scout_target_id: target.id,
          fb_group_id: target.fb_group_id,
          fb_group_url: target.fb_group_url || '',
          account_id: chosenAccount.id,
          max_posts: 20,
          max_comments_per_post: 50,
          scan_replies: false,
        }

        const { error: insertErr } = await supabase.from('jobs').insert({
          type: 'scan_group',
          status: 'pending',
          created_by: target.user_id,
          payload: jobPayload,
          scheduled_at: new Date().toISOString(),
          priority: 50, // low priority — don't block campaigns
        })

        if (insertErr) {
          console.warn(
            `[SCOUT-SCHEDULER] Failed to create job for ${target.name || target.fb_group_id}: ${insertErr.message}`
          )
          continue
        }

        // 7. Update last_scanned_at
        await supabase
          .from('scout_targets')
          .update({ last_scanned_at: new Date().toISOString() })
          .eq('id', target.id)

        jobsCreated++
        console.log(
          `[SCOUT-SCHEDULER] Created scan_group job for "${target.name || target.fb_group_id}" → nick ${chosenAccount.username || chosenAccount.id.slice(0, 8)}`
        )
      } catch (targetErr) {
        console.warn(
          `[SCOUT-SCHEDULER] Error processing target ${target.id}: ${targetErr.message}`
        )
      }
    }

    if (jobsCreated > 0) {
      console.log(
        `[SCOUT-SCHEDULER] Created ${jobsCreated} scan job(s) this cycle`
      )
    }
  } catch (err) {
    console.error(`[SCOUT-SCHEDULER] Cycle error: ${err.message}`)
  }
}

function startScoutScheduler(supabase) {
  console.log(
    `[SCOUT-SCHEDULER] Starting (poll every ${SCOUT_POLL_MS / 60000} min)...`
  )

  // Run once after initial delay
  _timeout = setTimeout(() => {
    runScoutScheduler(supabase)
  }, INITIAL_DELAY_MS)

  // Then run on interval
  _interval = setInterval(() => {
    runScoutScheduler(supabase)
  }, SCOUT_POLL_MS)
}

function stopScoutScheduler() {
  if (_timeout) {
    clearTimeout(_timeout)
    _timeout = null
  }
  if (_interval) {
    clearInterval(_interval)
    _interval = null
  }
  console.log('[SCOUT-SCHEDULER] Stopped')
}

module.exports = { startScoutScheduler, stopScoutScheduler }
