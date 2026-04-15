/**
 * Campaign Handler: Opportunity React (campaign_opportunity_react)
 * Comments on a high-scoring opportunity post detected by group-monitor.
 * Uses a DIFFERENT nick than the scanner to appear natural.
 */

const { getPage, releaseSession } = require('../../browser/session-pool')
const { delay, humanScroll, humanMouseMove } = require('../../browser/human')
const { checkAccountStatus, saveDebugScreenshot } = require('./post-utils')
const { checkHardLimit, applyAgeFactor, getNickAgeDays } = require('../../lib/hard-limits')
const { qualityGateComment } = require('../../lib/ai-brain')
const { generateOpportunityComment } = require('../../lib/ai-comment')
const { toMobileUrl, COMMENT_INPUT_SELECTORS, COMMENT_SUBMIT_SELECTORS } = require('../../lib/mobile-selectors')
const { ActivityLogger } = require('../../lib/activity-logger')
const R = require('../../lib/randomizer')

async function campaignOpportunityReact(payload, supabase) {
  const { opportunity_id, account_id, campaign_id, owner_id } = payload
  const startTime = Date.now()

  const logger = new ActivityLogger(supabase, {
    campaign_id,
    account_id,
    job_id: payload.job_id,
    owner_id: owner_id || payload.created_by,
  })

  // Load opportunity with monitored_group config
  const { data: opp } = await supabase
    .from('group_opportunities')
    .select('*, monitored_groups(*)')
    .eq('id', opportunity_id)
    .single()

  if (!opp) throw new Error('Opportunity not found')

  // Race condition guard: status must still be 'acting'
  if (opp.status !== 'acting') {
    console.log(`[OPP-REACT] Opportunity ${opportunity_id} status is "${opp.status}", skipping`)
    return { skipped: true, reason: `status_changed_to_${opp.status}` }
  }

  // Load account
  const { data: account } = await supabase
    .from('accounts')
    .select('*, proxies(*)')
    .eq('id', account_id)
    .single()
  if (!account) throw new Error('Account not found')

  await checkAccountStatus(account, supabase)

  const nickAge = getNickAgeDays(account)

  // Comment dedup: check if ANY nick already commented on this post (cross-system)
  if (opp.post_fb_id || opp.post_url) {
    let dedupQuery = supabase
      .from('comment_logs')
      .select('id', { count: 'exact', head: true })
      .eq('account_id', account_id)

    if (opp.post_fb_id) {
      dedupQuery = dedupQuery.eq('fb_post_id', opp.post_fb_id)
    } else {
      dedupQuery = dedupQuery.eq('post_url', opp.post_url)
    }

    const { count: alreadyCommented } = await dedupQuery
    if (alreadyCommented > 0) {
      await supabase.from('group_opportunities')
        .update({ status: 'skipped', skip_reason: 'already_commented_by_this_nick' })
        .eq('id', opportunity_id)
      console.log(`[OPP-REACT] Nick ${account_id.slice(0, 8)} already commented on ${opp.post_fb_id}, skipping`)
      return { skipped: true, reason: 'already_commented' }
    }
  }

  // Hard limit check for comment
  const commentBudget = account.daily_budget?.comment || { used: 0, max: 25 }
  const commentCheck = checkHardLimit('comment', commentBudget.used, 0)
  if (!commentCheck.allowed) {
    // Return to pending so another nick can pick it up
    await supabase.from('group_opportunities')
      .update({ status: 'pending' })
      .eq('id', opportunity_id)
    console.log(`[OPP-REACT] Comment budget exceeded for ${account_id}, returning opportunity to pending`)
    return { skipped: true, reason: commentCheck.reason || 'comment_budget_exceeded' }
  }

  // Generate opportunity comment with brand context
  const mg = opp.monitored_groups
  let commentResult
  try {
    commentResult = await generateOpportunityComment({
      postContent: opp.post_content,
      brandKeywords: mg?.brand_keywords || [],
      brandName: mg?.brand_name || '',
      brandVoice: mg?.brand_voice || 'thân thiện, tự nhiên',
      opportunityReason: opp.opportunity_reason,
      userId: owner_id,
      accountId: account_id,
      campaignId: mg?.campaign_id || payload.campaign_id,
      groupFbId: opp.fb_group_id || mg?.fb_group_id,
    })
  } catch (err) {
    console.warn(`[OPP-REACT] Comment generation failed: ${err.message}`)
    await supabase.from('group_opportunities')
      .update({ status: 'failed', skip_reason: `comment_gen_failed: ${err.message}` })
      .eq('id', opportunity_id)
    throw err
  }

  const commentText = commentResult?.text || ''
  if (!commentText || commentText.length < 5) {
    await supabase.from('group_opportunities')
      .update({ status: 'skipped', skip_reason: 'empty_comment_generated' })
      .eq('id', opportunity_id)
    return { skipped: true, reason: 'empty_comment' }
  }

  // Quality gate
  try {
    const qg = await qualityGateComment({
      commentText,
      postText: opp.post_content,
      topic: mg?.brand_keywords?.join(', ') || '',
      nickAge,
    })
    if (qg && !qg.approved) {
      console.log(`[OPP-REACT] Comment rejected by quality gate: ${qg.reason}`)
      await supabase.from('group_opportunities')
        .update({ status: 'skipped', skip_reason: `quality_gate: ${qg.reason}`, comment_generated: commentText })
        .eq('id', opportunity_id)
      return { skipped: true, reason: `quality_gate: ${qg.reason}` }
    }
  } catch (err) {
    // Quality gate failure is non-fatal — proceed with comment
    console.warn(`[OPP-REACT] Quality gate error (proceeding): ${err.message}`)
  }

  // Execute comment via browser
  let page, session
  let commentPosted = false
  let actualComment = commentText

  try {
    const result = await getPage(account)
    page = result.page
    session = result.session

    // Navigate to post (mobile URL for comment reliability)
    const postUrl = opp.post_url
    if (!postUrl) throw new Error('No post URL')

    const mobileUrl = toMobileUrl(postUrl)
    console.log(`[OPP-REACT] Commenting on ${mobileUrl}`)

    await page.goto(mobileUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await delay(R.between(2000, 4000))

    // Find comment input
    let commentInput = null
    for (const sel of COMMENT_INPUT_SELECTORS) {
      commentInput = await page.$(sel)
      if (commentInput) break
    }

    if (!commentInput) {
      // Try clicking "Write a comment..." link first
      const commentLinks = [
        '[data-sigil="comment-area-open"]',
        'a[href*="comment"]',
        'div[data-sigil*="comment"]',
      ]
      for (const sel of commentLinks) {
        const link = await page.$(sel)
        if (link) {
          await link.click()
          await delay(R.between(1000, 2000))
          break
        }
      }
      // Retry finding input
      for (const sel of COMMENT_INPUT_SELECTORS) {
        commentInput = await page.$(sel)
        if (commentInput) break
      }
    }

    if (!commentInput) {
      throw new Error('ELEMENT_NOT_FOUND: Comment input not found')
    }

    // Type comment with human-like delays
    await commentInput.click()
    await delay(R.between(500, 1000))
    await commentInput.type(commentText, { delay: R.between(30, 80) })
    await delay(R.between(1000, 2000))

    // Submit comment
    let submitted = false
    for (const sel of COMMENT_SUBMIT_SELECTORS) {
      const btn = await page.$(sel)
      if (btn) {
        await btn.click()
        submitted = true
        break
      }
    }

    if (!submitted) {
      // Try Enter key
      await page.keyboard.press('Enter')
    }

    await delay(R.between(2000, 4000))
    commentPosted = true
    console.log(`[OPP-REACT] Comment posted on ${opp.post_fb_id}: "${commentText.substring(0, 50)}..."`)

  } catch (err) {
    console.error(`[OPP-REACT] Comment failed: ${err.message}`)
    await supabase.from('group_opportunities').update({
      status: 'failed',
      skip_reason: err.message,
      comment_generated: commentText,
      acted_by_account_id: account_id,
    }).eq('id', opportunity_id)

    logger.log('opportunity_comment', {
      target_type: 'group',
      target_name: mg?.group_name,
      target_id: opp.post_fb_id,
      result_status: 'failed',
      details: { error: err.message, comment_text: commentText },
    })
    await logger.flush()

    throw err
  } finally {
    if (account_id) {
      await releaseSession(account_id, supabase).catch(err =>
        console.warn(`[OPP-REACT] Release session error: ${err.message}`)
      )
    }
  }

  // Update opportunity
  await supabase.from('group_opportunities').update({
    status: commentPosted ? 'acted' : 'failed',
    acted_by_account_id: account_id,
    comment_generated: commentText,
    comment_posted: actualComment,
    acted_at: new Date().toISOString(),
  }).eq('id', opportunity_id)

  // Update monitored_groups total_acted
  if (commentPosted) {
    await supabase.from('monitored_groups').update({
      total_acted: (mg?.total_acted || 0) + 1,
    }).eq('id', opp.monitored_group_id)

    // Increment comment budget
    await supabase.from('accounts').update({
      daily_budget: {
        ...account.daily_budget,
        comment: { ...commentBudget, used: commentBudget.used + 1 },
      },
    }).eq('id', account_id)
  }

  logger.log('opportunity_comment', {
    target_type: 'group',
    target_name: mg?.group_name,
    target_id: opp.post_fb_id,
    target_url: opp.post_url,
    result_status: commentPosted ? 'success' : 'failed',
    details: {
      opportunity_score: opp.opportunity_score,
      comment_text: commentText,
      group_fb_id: mg?.group_fb_id,
    },
    duration_ms: Date.now() - startTime,
  })
  await logger.flush()

  // Level C: Remember group response pattern
  try {
    const { remember } = require('../../lib/ai-memory')
    if (campaign_id && mg?.group_fb_id) {
      await remember(supabase, {
        campaignId: campaign_id, groupFbId: mg.group_fb_id,
        memoryType: 'group_response', key: 'opportunity_react_result',
        value: {
          success: commentPosted,
          score: opp.opportunity_score,
          hour: new Date().getHours(),
        },
      })
    }
  } catch {}

  return {
    success: commentPosted,
    comment: commentText,
    opportunity_score: opp.opportunity_score,
    duration_seconds: Math.round((Date.now() - startTime) / 1000),
  }
}

module.exports = campaignOpportunityReact
