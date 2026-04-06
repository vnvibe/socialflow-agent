/**
 * Campaign Handler: Group Monitor (campaign_group_monitor)
 * Scans a monitored group's feed, evaluates posts against brand keywords,
 * and inserts high-scoring opportunities into group_opportunities.
 * Does NOT interact — only reads and evaluates.
 */

const { getPage, releaseSession } = require('../../browser/session-pool')
const { delay, humanScroll } = require('../../browser/human')
const { checkAccountStatus } = require('./post-utils')
const { scanGroupPosts, evaluateOpportunities } = require('../../lib/ai-brain')
const { ActivityLogger } = require('../../lib/activity-logger')
const R = require('../../lib/randomizer')

async function campaignGroupMonitor(payload, supabase) {
  const {
    monitored_group_id, account_id, campaign_id, owner_id,
    group_fb_id, group_name, group_url,
    brand_keywords, brand_name, brand_voice,
    opportunity_threshold, scan_lookback_minutes,
  } = payload

  const startTime = Date.now()

  const logger = new ActivityLogger(supabase, {
    campaign_id,
    account_id,
    job_id: payload.job_id,
    owner_id: owner_id || payload.created_by,
  })

  // Load account
  const { data: account } = await supabase
    .from('accounts')
    .select('*, proxies(*)')
    .eq('id', account_id)
    .single()
  if (!account) throw new Error('Account not found')

  await checkAccountStatus(account, supabase)

  // Load existing post IDs to dedup (last 24h)
  const { data: existing } = await supabase
    .from('group_opportunities')
    .select('post_fb_id')
    .eq('monitored_group_id', monitored_group_id)
    .gte('detected_at', new Date(Date.now() - 24 * 3600 * 1000).toISOString())

  const seenPostIds = new Set((existing || []).map(r => r.post_fb_id))

  let page, session
  try {
    // Acquire browser session
    const result = await getPage(account)
    page = result.page
    session = result.session

    // Navigate to group
    const url = group_url || `https://www.facebook.com/groups/${group_fb_id}`
    console.log(`[GROUP-MONITOR] Scanning "${group_name}" (${url})`)

    // Scan group feed — reuse existing scanGroupPosts from ai-brain
    const posts = await scanGroupPosts(page, {
      groupUrl: url,
      groupFbId: group_fb_id,
      limit: 30,
      lookbackMinutes: scan_lookback_minutes || 180,
    })

    console.log(`[GROUP-MONITOR] Found ${posts.length} posts in "${group_name}"`)

    // Filter out already-seen posts
    const newPosts = posts.filter(p => p.fb_id && !seenPostIds.has(p.fb_id))
    console.log(`[GROUP-MONITOR] ${newPosts.length} new posts (${seenPostIds.size} already tracked)`)

    if (newPosts.length === 0) {
      // Update stats even if no new posts
      await supabase.from('monitored_groups').update({
        total_scans: supabase.rpc ? undefined : undefined, // increment below
        last_scanned_at: new Date().toISOString(),
      }).eq('id', monitored_group_id)

      // Increment total_scans via raw update
      await supabase.rpc('increment_field', {
        table_name: 'monitored_groups',
        field_name: 'total_scans',
        row_id: monitored_group_id,
      }).catch(() => {
        // Fallback: simple update
        supabase.from('monitored_groups').update({
          total_scans: (payload._current_scans || 0) + 1,
        }).eq('id', monitored_group_id)
      })

      logger.log('scan', {
        target_type: 'group',
        target_name: group_name,
        target_id: group_fb_id,
        result_status: 'success',
        details: { total_posts: posts.length, new_posts: 0 },
      })
      await logger.flush()

      return {
        success: true,
        scanned: posts.length,
        new: 0,
        opportunities: 0,
        duration_seconds: Math.round((Date.now() - startTime) / 1000),
      }
    }

    // AI evaluate posts against brand keywords
    let evaluations = []
    try {
      evaluations = await evaluateOpportunities(newPosts, {
        brandKeywords: brand_keywords || [],
        brandName: brand_name || '',
        threshold: opportunity_threshold || 7,
        ownerId: owner_id,
      })
    } catch (err) {
      console.warn(`[GROUP-MONITOR] AI evaluation failed: ${err.message} — using keyword fallback`)
      // Simple keyword fallback: check if post contains any brand keyword
      evaluations = newPosts
        .map(p => {
          const text = (p.body || p.text || '').toLowerCase()
          const matched = (brand_keywords || []).filter(kw => text.includes(kw.toLowerCase()))
          if (matched.length === 0) return null
          return {
            post: p,
            score: Math.min(6 + matched.length, 10),
            reason: `Keyword match: ${matched.join(', ')}`,
            matchedKeywords: matched,
          }
        })
        .filter(Boolean)
    }

    // Filter by threshold and insert opportunities
    const qualifiedOpps = evaluations.filter(e => e.score >= (opportunity_threshold || 7))
    console.log(`[GROUP-MONITOR] ${qualifiedOpps.length}/${evaluations.length} opportunities meet threshold (>=${opportunity_threshold})`)

    if (qualifiedOpps.length > 0) {
      const rows = qualifiedOpps.map(e => ({
        owner_id,
        monitored_group_id,
        campaign_id,
        post_fb_id: e.post.fb_id || e.post.id,
        post_content: (e.post.body || e.post.text || '').substring(0, 2000),
        post_author: e.post.author || e.post.authorName || null,
        post_url: e.post.url || e.post.permalink || null,
        post_created_at: e.post.created_at || e.post.timestamp || null,
        post_reactions: e.post.reactions || e.post.reactionCount || 0,
        post_comments: e.post.comments || e.post.commentCount || 0,
        opportunity_score: e.score,
        opportunity_reason: e.reason,
        matched_keywords: e.matchedKeywords || [],
        status: 'pending',
      }))

      // Upsert to handle race conditions (unique on monitored_group_id + post_fb_id)
      const { error: insertErr } = await supabase
        .from('group_opportunities')
        .upsert(rows, { onConflict: 'monitored_group_id,post_fb_id', ignoreDuplicates: true })

      if (insertErr) {
        console.error(`[GROUP-MONITOR] Insert opportunities error:`, insertErr.message)
      }
    }

    // Update monitored_groups stats
    await supabase.from('monitored_groups').update({
      last_scanned_at: new Date().toISOString(),
      total_scans: (payload._current_scans || 0) + 1,
      total_opportunities: (payload._current_opps || 0) + qualifiedOpps.length,
    }).eq('id', monitored_group_id)

    logger.log('scan', {
      target_type: 'group',
      target_name: group_name,
      target_id: group_fb_id,
      result_status: 'success',
      details: {
        total_posts: posts.length,
        new_posts: newPosts.length,
        evaluated: evaluations.length,
        opportunities: qualifiedOpps.length,
      },
    })

    return {
      success: true,
      scanned: posts.length,
      new: newPosts.length,
      opportunities: qualifiedOpps.length,
      duration_seconds: Math.round((Date.now() - startTime) / 1000),
    }
  } finally {
    if (account_id) {
      await releaseSession(account_id, supabase).catch(err =>
        console.warn(`[GROUP-MONITOR] Release session error: ${err.message}`)
      )
    }
    await logger.flush()
  }
}

module.exports = campaignGroupMonitor
