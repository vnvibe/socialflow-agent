/**
 * Campaign Handler: Post Content (Role: post)
 * Creates posts to pages/groups/profiles as part of a campaign role
 * Reuses post-utils for browser automation, supports AI content generation
 */

const { getPage, releaseSession } = require('../../browser/session-pool')
const { humanMouseMove, humanScroll } = require('../../browser/human')
const {
  checkAccountStatus, openComposer, typeCaption,
  uploadMedia, submitPost, savePublishHistory,
  updateAccountStats, saveDebugScreenshot,
  ensureDailyReset, checkDailyLimit,
  setupPostIdInterceptor, getInterceptedPostId,
} = require('./post-utils')
const { checkHardLimit } = require('../../lib/hard-limits')
const { getActionParams } = require('../../lib/plan-executor')
const R = require('../../lib/randomizer')
const axios = require('axios')
const { ActivityLogger } = require('../../lib/activity-logger')

const API_URL = process.env.API_URL || process.env.RAILWAY_URL || 'https://socialflow-production.up.railway.app'

async function campaignPost(payload, supabase) {
  const { account_id, campaign_id, role_id, config, topic, parsed_plan } = payload

  const logger = new ActivityLogger(supabase, {
    campaign_id, role_id, account_id,
    job_id: payload.job_id,
    owner_id: payload.owner_id || payload.created_by,
  })

  const { data: account } = await supabase
    .from('accounts')
    .select('*, proxies(*)')
    .eq('id', account_id)
    .single()
  if (!account) throw new Error('Account not found')

  // Budget check
  const postBudget = account.daily_budget?.post || { used: 0, max: 5 }
  const { allowed, remaining } = checkHardLimit('post', postBudget.used, 0)
  if (!allowed || remaining <= 0) {
    throw new Error('SKIP_post_budget_exceeded')
  }

  await ensureDailyReset(supabase, account)
  const limitOk = await checkDailyLimit(supabase, account)
  if (!limitOk) throw new Error('SKIP_daily_post_limit')

  // Resolve content — from config.content_id or generate via AI
  let caption = config?.caption || ''
  let hashtags = config?.hashtags || []
  let mediaUrl = null
  let contentId = config?.content_id || null

  if (contentId) {
    const { data: content } = await supabase
      .from('contents')
      .select('*, media(*)')
      .eq('id', contentId)
      .single()
    if (content) {
      caption = content.caption || ''
      hashtags = content.hashtags || []
      if (content.media?.url) mediaUrl = content.media.url
    }
  } else if (topic && !caption) {
    // Generate AI caption from topic
    try {
      const planParams = getActionParams(parsed_plan, 'post', { style: 'casual' })
      const style = planParams.style || config?.style || 'casual'
      const res = await axios.post(`${API_URL}/ai/caption`, {
        topic,
        style,
        language: 'vi',
        niche: config?.niche || topic,
      }, { timeout: 30000 })
      caption = res.data?.caption || ''
      hashtags = res.data?.hashtags || []
      console.log(`[CAMPAIGN-POST] AI generated caption (${style}): ${caption.substring(0, 80)}...`)
    } catch (err) {
      console.warn(`[CAMPAIGN-POST] AI caption failed: ${err.message}, using topic as caption`)
      caption = topic
    }
  }

  if (!caption) throw new Error('SKIP_no_content')

  // Build final caption with hashtags
  let finalCaption = caption
  if (hashtags.length > 0) {
    finalCaption += '\n\n' + hashtags.map(h => h.startsWith('#') ? h : `#${h}`).join(' ')
  }

  // Determine target
  const targetType = config?.target_type || 'profile' // page, group, profile
  const targetId = config?.target_id

  let targetUrl = null
  let targetName = null
  let targetFbId = null

  if (targetType === 'page' && targetId) {
    const { data: page } = await supabase.from('fanpages').select('*').eq('id', targetId).eq('account_id', account_id).single()
    if (page) {
      targetUrl = page.url || `https://www.facebook.com/${page.fb_page_id}`
      targetName = page.name
      targetFbId = page.fb_page_id
    }
  } else if (targetType === 'group' && targetId) {
    const { data: group } = await supabase.from('fb_groups').select('*').eq('id', targetId).eq('account_id', account_id).single()
    if (group) {
      targetUrl = group.url || `https://www.facebook.com/groups/${group.fb_group_id}`
      targetName = group.name
      targetFbId = group.fb_group_id
    }
  } else {
    // Profile post
    targetUrl = `https://www.facebook.com/${account.fb_user_id || 'me'}`
    targetName = account.username
    targetFbId = account.fb_user_id
  }

  if (!targetUrl) throw new Error('SKIP_no_target')

  let page
  try {
    const session = await getPage(account)
    page = session.page

    console.log(`[CAMPAIGN-POST] Posting to ${targetType}: ${targetName || targetUrl}`)
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await R.sleepRange(2000, 4000)
    await humanMouseMove(page)

    // Check account status
    await checkAccountStatus(page, supabase, account)

    // Setup post ID interceptor
    const interceptor = setupPostIdInterceptor(page)

    // Open composer
    await openComposer(page, targetType)
    await R.sleepRange(1000, 2000)

    // Type caption
    await typeCaption(page, finalCaption)
    await R.sleepRange(1000, 2000)

    // Upload media if available
    if (mediaUrl) {
      await uploadMedia(page, mediaUrl)
      await R.sleepRange(2000, 4000)
    }

    // Submit post
    await submitPost(page)
    await R.sleepRange(3000, 6000)

    // Get post ID
    const fbPostId = await getInterceptedPostId(interceptor, page)
    const postUrl = fbPostId
      ? (targetType === 'group'
        ? `https://www.facebook.com/groups/${targetFbId}/posts/${fbPostId}`
        : `https://www.facebook.com/${fbPostId}`)
      : null

    // Save publish history
    await savePublishHistory(supabase, {
      job_id: payload.job_id,
      content_id: contentId,
      account_id,
      target_type: targetType,
      target_fb_id: targetFbId,
      target_name: targetName,
      final_caption: finalCaption,
      fb_post_id: fbPostId,
      post_url: postUrl,
      status: 'success',
      owner_id: payload.created_by,
      campaign_id,
    })

    // Update stats
    await updateAccountStats(supabase, account)

    // Increment budget
    await supabase.rpc('increment_budget', {
      p_account_id: account_id,
      p_action_type: 'post',
    })

    console.log(`[CAMPAIGN-POST] Success: ${targetType} ${targetName} — ${postUrl || 'no URL captured'}`)
    logger.log('post', { target_type: targetType, target_id: targetFbId, target_name: targetName, target_url: postUrl, details: { caption: finalCaption.substring(0, 200), content_id: contentId } })
    return {
      success: true,
      target_type: targetType,
      target_name: targetName,
      post_url: postUrl,
    }
  } catch (err) {
    if (page) await saveDebugScreenshot(page, `campaign-post-${account_id}`)

    // Save failed publish history
    await savePublishHistory(supabase, {
      job_id: payload.job_id,
      content_id: contentId,
      account_id,
      target_type: targetType,
      target_fb_id: targetFbId,
      target_name: targetName,
      final_caption: finalCaption,
      status: 'failed',
      error_message: err.message,
      owner_id: payload.created_by,
      campaign_id,
    }).catch(() => {})

    logger.log('post', { target_type: targetType, target_id: targetFbId, target_name: targetName, result_status: 'failed', details: { error: err.message, content_id: contentId } })
    throw err
  } finally {
    await logger.flush().catch(() => {})
    if (page) // Keep page on FB for session reuse
    await releaseSession(account_id, supabase)
  }
}

module.exports = campaignPost
