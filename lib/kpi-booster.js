/**
 * Weighted random shuffle using Efraimidis-Spirakis A-ES algorithm
 * @param {Array} rows - Data items to shuffle
 * @param {Function} weightFn - Function returning numerical weight for each item
 */
function weightedShuffle(rows, weightFn) {
  return rows
    .map(r => ({
      r,
      key: Math.pow(Math.random(), 1 / Math.max(weightFn(r), 0.01)),
    }))
    .sort((a, b) => b.key - a.key)
    .map(x => x.r)
}

/**
 * Boost nicks that have 0 approved (is_member=true, pending_approval=false) groups
 */
async function boostZeroApprovedGroupNicks(supabase, options = {}) {
  const { forceNow = true, ownerId = null } = options

  // Only process accounts of owners with active/running (non-paused) campaigns
  const { data: activeCamps, error: campErr } = await supabase
    .from('campaigns')
    .select('owner_id')
    .or('status.in.(active,running),is_active.eq.true')
    .neq('status', 'paused')

  if (campErr) {
    console.warn(`[KPI-BOOSTER] boostZeroApprovedGroupNicks: failed to fetch campaigns:`, campErr.message)
    return { boosted: 0 }
  }

  const activeOwnerIds = [...new Set((activeCamps || []).map(c => c.owner_id).filter(Boolean))]

  if (!activeOwnerIds.length && !ownerId) return { boosted: 0 }

  let query = supabase.from('accounts').select('id, owner_id').eq('is_active', true)

  if (ownerId) {
    query = query.eq('owner_id', ownerId)
  } else if (activeOwnerIds.length > 0) {
    query = query.in('owner_id', activeOwnerIds)
  }

  const { data: activeAccs, error: accErr } = await query
  if (accErr) {
    console.warn(`[KPI-BOOSTER] boostZeroApprovedGroupNicks: failed to fetch accounts:`, accErr.message)
    return { boosted: 0 }
  }
  if (!activeAccs?.length) return { boosted: 0 }

  let boosted = 0
  for (const acc of activeAccs) {
    // FIX Bug 2: destructure error from count query, skip if DB error (not just null count)
    const { count: approvedCount, error: countErr } = await supabase
      .from('fb_groups')
      .select('id', { count: 'exact', head: true })
      .eq('account_id', acc.id)
      .eq('is_member', true)
      .eq('pending_approval', false)

    if (countErr) {
      console.warn(`[KPI-BOOSTER] Failed to count approved groups for ${acc.id.slice(0,8)}:`, countErr.message)
      continue
    }

    if (approvedCount > 0) continue // đã có ít nhất 1 nhóm dùng được, bỏ qua

    // Tránh spam: tối đa 1 job discover/24h cho mỗi nick, bất kể status
    const { data: recentJoinJobs } = await supabase.from('jobs')
      .select('id')
      .eq('type', 'campaign_discover_groups')
      .eq('payload->>account_id', acc.id)
      .gte('created_at', new Date(Date.now() - 24 * 3600 * 1000).toISOString())
      .limit(1)
    if (recentJoinJobs?.length) continue

    // FIX Bug 4: log insErr when insert fails — don't silently swallow errors
    const { error: insErr } = await supabase.from('jobs').insert({
      type: 'campaign_discover_groups',
      priority: 2, // thấp hơn KPI-boost comment job (priority 1) — ưu tiên comment trước
      payload: {
        account_id: acc.id,
        owner_id: acc.owner_id,
        force_now: forceNow,
        zero_approved_groups_boost: true,
      },
      status: 'pending',
      scheduled_at: new Date().toISOString(),
      created_by: acc.owner_id,
    })

    if (insErr) {
      console.error(`[KPI-BOOSTER] Failed to enqueue discover_groups for Nick ${acc.id.slice(0,8)}:`, insErr.message)
    } else {
      boosted++
      console.log(`[KPI-BOOSTER] 🆘 Nick ${acc.id.slice(0,8)} có 0 nhóm được duyệt — đã enqueue campaign_discover_groups job`)
    }
  }

  if (boosted > 0) console.log(`[KPI-BOOSTER] Zero-approved-group boost: ${boosted} nick được enqueue`)
  return { boosted }
}

/**
 * Get current date string in VN timezone (UTC+7) YYYY-MM-DD
 */
function getVnDateString() {
  return new Date(Date.now() + 7 * 3600 * 1000).toISOString().split('T')[0]
}

/**
 * Main KPI Check & Boost logic
 */
async function checkAndBoostKPI(supabase, options = {}) {
  const { campaignId = null, accountId = null, forceNow = true } = options
  const today = getVnDateString()

  console.log(`[KPI-BOOSTER] Checking daily KPI completion status for date: ${today}...`)

  try {
    // 1. Fetch daily KPI rows for today
    let baseQuery = supabase
      .from('nick_kpi_daily')
      .select('id, campaign_id, account_id, date, target_likes, done_likes, target_comments, done_comments, target_friend_requests, done_friend_requests, target_group_joins, done_group_joins, kpi_met')
      .eq('date', today)

    if (campaignId) baseQuery = baseQuery.eq('campaign_id', campaignId)
    if (accountId) baseQuery = baseQuery.eq('account_id', accountId)

    let { data: rows, error } = await baseQuery
    if (error) {
      console.error(`[KPI-BOOSTER] Error fetching nick_kpi_daily:`, error.message)
      return { success: false, error: error.message }
    }

    // 2. Ensure all active nicks of active campaigns have a daily KPI row for today
    try {
      const { data: activeCamps } = await supabase
        .from('campaigns')
        .select('id, owner_id')
        .or('status.in.(active,running),is_active.eq.true')
        .neq('status', 'paused')
      const { data: activeAccs } = await supabase
        .from('accounts')
        .select('id, owner_id')
        .eq('is_active', true)

      if (activeCamps?.length && activeAccs?.length) {
        const existingNickSet = new Set((rows || []).map(r => `${r.campaign_id}_${r.account_id}`))
        const missingRows = []
        for (const c of activeCamps) {
          for (const a of activeAccs) {
            if (a.owner_id === c.owner_id && !existingNickSet.has(`${c.id}_${a.id}`)) {
              missingRows.push({
                campaign_id: c.id,
                account_id: a.id,
                date: today,
                target_comments: 6,
                target_likes: 26,
                done_comments: 0,
                done_likes: 0,
                kpi_met: false,
              })
            }
          }
        }
        if (missingRows.length > 0) {
          console.log(`[KPI-BOOSTER] Auto-creating ${missingRows.length} missing nick_kpi_daily row(s) for today (${today})...`)
          await supabase.from('nick_kpi_daily').upsert(missingRows, { onConflict: 'campaign_id,account_id,date', ignoreDuplicates: true })

          // FIX Bug 3: Re-build query fresh instead of re-executing the consumed query object
          let refreshQuery = supabase
            .from('nick_kpi_daily')
            .select('id, campaign_id, account_id, date, target_likes, done_likes, target_comments, done_comments, target_friend_requests, done_friend_requests, target_group_joins, done_group_joins, kpi_met')
            .eq('date', today)
          if (campaignId) refreshQuery = refreshQuery.eq('campaign_id', campaignId)
          if (accountId) refreshQuery = refreshQuery.eq('account_id', accountId)
          const { data: refreshed } = await refreshQuery
          rows = refreshed || []
        }
      }
    } catch (initErr) {
      console.warn(`[KPI-BOOSTER] Failed to auto-initialize missing nick_kpi_daily rows:`, initErr.message)
    }

    // Boost nicks with 0 approved groups independently of daily KPI rows
    await boostZeroApprovedGroupNicks(supabase, { forceNow })

    if (!rows || rows.length === 0) {
      return { success: true, boostedJobsCount: 0, rowsChecked: 0 }
    }

    // ── Weighted random shuffle: nick thiếu KPI càng nhiều, xác suất đứng đầu
    // hàng đợi càng cao (được schedule sớm hơn → nhiều giờ catch-up hơn),
    // nhưng vẫn là random thật — không sort cứng theo priority ──
    const shuffledRows = weightedShuffle(rows, (row) => {
      const missingComments = Math.max(0, (row.target_comments || 0) - (row.done_comments || 0))
      const missingLikes = Math.max(0, (row.target_likes || 0) - (row.done_likes || 0))
      return missingComments + missingLikes
    })

    const activeNickCount = Math.max(1, shuffledRows.length)
    // VN Time (UTC+7) remaining hours today
    const currentVnHour = new Date(Date.now() + 7 * 3600 * 1000).getUTCHours()
    const hoursLeftToday = Math.max(1, 24 - currentVnHour)

    // Dynamic interleave gap: 45-90s during aggressive forceNow boost, or 3-6m during normal background runs
    // Ensures rapid comment job pumping when requested by user while avoiding 429 rate limits
    const interleaveGapSec = forceNow
      ? Math.max(45, Math.min(90, Math.floor(180 / activeNickCount)))
      : Math.max(180, Math.min(360, Math.floor(600 / activeNickCount)))

    console.log(`[KPI-BOOSTER] Evaluated ${shuffledRows.length} nick KPI row(s). Active nicks: ${activeNickCount}, Hours left today: ${hoursLeftToday}h, Interleave gap: ${interleaveGapSec}s (forceNow=${!!forceNow}).`)

    // FIX Bug 5 & 6: Pre-load all campaigns and accounts in bulk → eliminate N+1 queries
    const campaignIds = [...new Set(shuffledRows.map(r => r.campaign_id))]
    const accountIds = [...new Set(shuffledRows.map(r => r.account_id))]

    const { data: allCamps } = await supabase
      .from('campaigns')
      .select('id, status, is_active')
      .in('id', campaignIds)

    const { data: allAccs } = await supabase
      .from('accounts')
      .select('id, is_active, owner_id, status')
      .in('id', accountIds)

    const campMap = Object.fromEntries((allCamps || []).map(c => [c.id, c]))
    const accMap = Object.fromEntries((allAccs || []).map(a => [a.id, a]))

    let enqueuedCount = 0
    const nickSummaries = []

    for (const row of shuffledRows) {
      const tgtComments = row.target_comments || 0
      const doneComments = row.done_comments || 0
      const tgtLikes = row.target_likes || 0
      const doneLikes = row.done_likes || 0
      const tgtFriends = row.target_friend_requests || 0
      const doneFriends = row.done_friend_requests || 0
      const tgtJoins = row.target_group_joins || 0
      const doneJoins = row.done_group_joins || 0

      const missingComments = Math.max(0, tgtComments - doneComments)
      const missingLikes = Math.max(0, tgtLikes - doneLikes)
      const missingFriends = Math.max(0, tgtFriends - doneFriends)
      const missingJoins = Math.max(0, tgtJoins - doneJoins)

      const isFullyMet = missingComments === 0 && missingLikes === 0 && missingFriends === 0 && missingJoins === 0

      nickSummaries.push({
        nickId: row.account_id,
        campaignId: row.campaign_id,
        missingComments,
        missingLikes,
        missingFriends,
        missingJoins,
        isFullyMet,
      })

      if (isFullyMet) {
        if (!row.kpi_met) {
          await supabase.from('nick_kpi_daily').update({ kpi_met: true }).eq('id', row.id).catch(() => {})
        }
        continue
      }

      // FIX Bug 5: Use pre-loaded campMap instead of per-row DB query
      const camp = campMap[row.campaign_id]
      const isCampActive = camp && (['active', 'running'].includes(camp.status) || camp.is_active === true)
      if (!isCampActive) {
        console.log(`[KPI-BOOSTER] Campaign ${row.campaign_id.slice(0, 8)} status is '${camp?.status || 'inactive'}'. Skipping boost.`)
        continue
      }

      // Allow all accounts to be enqueued regardless of status (user directive: force all nicks to run)
      const acc = accMap[row.account_id]
      if (!acc) {
        console.log(`[KPI-BOOSTER] Account ${row.account_id.slice(0, 8)} is missing from DB. Skipping boost.`)
        continue
      }

      // ── Enqueue Nurture Boost Job (100% Comment Focus) ──
      if (missingComments > 0) {
        // Check if there is already a pending or running campaign_nurture job for this nick (deduplication)
        const { data: existingJobs } = await supabase.from('jobs')
          .select('id')
          .in('status', ['pending', 'running'])
          .eq('type', 'campaign_nurture')
          .eq('payload->>account_id', row.account_id)
          .eq('payload->>campaign_id', row.campaign_id)
          .limit(1)

        if (!existingJobs || existingJobs.length === 0) {
          // Interleaved dynamic interval: stagger nicks by 3-6 mins + 15s-45s random noise to prevent 429 rate limit spikes
          const randomJitterMs = Math.floor(15000 + Math.random() * 30000)
          const staggerOffsetMs = (enqueuedCount * interleaveGapSec * 1000) + randomJitterMs
          const scheduledAtIso = new Date(Date.now() + staggerOffsetMs).toISOString()

          console.log(`[KPI-BOOSTER] 💬 Nick ${row.account_id.slice(0, 8)} selected (100% Comment Focus). KPI: ${doneComments}/${tgtComments} comments. Auto-enqueuing job (+${Math.round(staggerOffsetMs / 1000)}s).`)
          const { error: insErr } = await supabase.from('jobs').insert({
            type: 'campaign_nurture',
            priority: 1, // High priority KPI boost / auto-redo
            payload: {
              account_id: row.account_id,
              campaign_id: row.campaign_id,
              owner_id: acc.owner_id,
              force_now: forceNow,
              kpi_boost: true,
              bypass_safety_limits: true,
              target_comments_remaining: missingComments,
              target_likes_remaining: 0,
            },
            status: 'pending',
            scheduled_at: scheduledAtIso,
            created_by: acc.owner_id,
          })

          if (insErr) {
            console.error(`[KPI-BOOSTER] Failed to enqueue nurture job for Nick ${row.account_id.slice(0, 8)}:`, insErr.message)
          } else {
            enqueuedCount++
            console.log(`[KPI-BOOSTER] 🔥 Auto-enqueued randomized 429-safe job for Nick ${row.account_id.slice(0, 8)} (Comments remaining: ${missingComments}/${tgtComments})`)
          }
        }
      }

      // ── Enqueue Friend Request Boost Job (Disabled by user request to focus strictly on commenting) ──
      /*
      if (missingFriends > 0) {
        const { data: existingFriendJobs } = await supabase.from('jobs')
          .select('id')
          .in('status', ['pending', 'running'])
          .eq('type', 'campaign_send_friend_request')
          .eq('payload->>account_id', row.account_id)
          .eq('payload->>campaign_id', row.campaign_id)
          .limit(1)

        if (!existingFriendJobs || existingFriendJobs.length === 0) {
          const { error: insErr } = await supabase.from('jobs').insert({
            type: 'campaign_send_friend_request',
            priority: 1,
            payload: {
              account_id: row.account_id,
              campaign_id: row.campaign_id,
              owner_id: acc.owner_id,
              force_now: forceNow,
              kpi_boost: true,
              target_friends_remaining: missingFriends,
            },
            status: 'pending',
            scheduled_at: new Date().toISOString(),
            created_by: acc.owner_id,
          })

          if (!insErr) {
            enqueuedCount++
            console.log(`[KPI-BOOSTER] 🔥 Boosted friend_request job for Nick ${row.account_id.slice(0, 8)} (Friends missing: ${missingFriends})`)
          }
        }
      }
      */

      // ── Enqueue Group Join Boost Job (Disabled by user request to focus strictly on commenting) ──
      /*
      if (missingJoins > 0) {
        const { data: existingJoinJobs } = await supabase.from('jobs')
          .select('id')
          .in('status', ['pending', 'running'])
          .eq('type', 'campaign_discover_groups')
          .eq('payload->>account_id', row.account_id)
          .eq('payload->>campaign_id', row.campaign_id)
          .limit(1)

        if (!existingJoinJobs || existingJoinJobs.length === 0) {
          const { error: insErr } = await supabase.from('jobs').insert({
            type: 'campaign_discover_groups',
            priority: 1,
            payload: {
              account_id: row.account_id,
              campaign_id: row.campaign_id,
              owner_id: acc.owner_id,
              force_now: forceNow,
              kpi_boost: true,
              target_joins_remaining: missingJoins,
            },
            status: 'pending',
            scheduled_at: new Date().toISOString(),
            created_by: acc.owner_id,
          })

          if (!insErr) {
            enqueuedCount++
            console.log(`[KPI-BOOSTER] 🔥 Boosted discover_groups job for Nick ${row.account_id.slice(0, 8)} (Group Joins missing: ${missingJoins})`)
          }
        }
      }
      */
    }

    console.log(`[KPI-BOOSTER] Boost complete. Enqueued ${enqueuedCount} high-priority KPI completion job(s).`)
    return {
      success: true,
      today,
      rowsChecked: rows.length,
      enqueuedCount,
      nickSummaries,
    }
  } catch (err) {
    console.error(`[KPI-BOOSTER] Exception during checkAndBoostKPI:`, err.message)
    return { success: false, error: err.message }
  }
}

module.exports = { checkAndBoostKPI, getVnDateString, weightedShuffle, boostZeroApprovedGroupNicks }
