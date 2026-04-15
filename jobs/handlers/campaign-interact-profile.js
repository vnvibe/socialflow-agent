/**
 * Campaign Handler: Interact Profile (Role: connect)
 * Visit target profile, browse, like posts, optionally comment
 */

const { getPage, releaseSession } = require('../../browser/session-pool')
const { humanScroll, humanMouseMove, humanClick } = require('../../browser/human')
const { saveDebugScreenshot } = require('./post-utils')
const { checkHardLimit } = require('../../lib/hard-limits')
const R = require('../../lib/randomizer')
const { getActionParams } = require('../../lib/plan-executor')
const { generateComment } = require('../../lib/ai-comment')
const { ActivityLogger } = require('../../lib/activity-logger')

async function campaignInteractProfile(payload, supabase) {
  const { account_id, campaign_id, role_id, config, read_from, parsed_plan } = payload
  let targetUrl = config?.target_url || config?.fb_profile_url
  let targetFbId = config?.target_fb_id
  let claimedTargetId = null

  // Workflow chaining: if read_from is set, claim target from queue
  if (!targetUrl && !targetFbId && read_from) {
    const { data: targets } = await supabase.rpc('claim_targets', {
      p_campaign_id: campaign_id,
      p_target_role_id: role_id,
      p_account_id: account_id,
      p_limit: 1,
    })
    if (targets?.length) {
      targetUrl = targets[0].fb_profile_url
      targetFbId = targets[0].fb_user_id
      claimedTargetId = targets[0].id
      console.log(`[CAMPAIGN-INTERACT] Claimed target from queue: ${targets[0].fb_user_name || targetFbId}`)
    }
  }

  if (!targetUrl && !targetFbId) throw new Error('SKIP_no_target_profile')

  const { data: account } = await supabase
    .from('accounts')
    .select('*, proxies(*)')
    .eq('id', account_id)
    .single()
  if (!account) throw new Error('Account not found')

  const logger = new ActivityLogger(supabase, {
    campaign_id, role_id, account_id,
    job_id: payload.job_id,
    owner_id: payload.owner_id || payload.created_by,
  })

  const likeBudget = account.daily_budget?.like || { used: 0, max: 80 }
  const likeCheck = checkHardLimit('like', likeBudget.used, 0)

  let page
  try {
    const session = await getPage(account)
    page = session.page

    const profileUrl = targetUrl || `https://www.facebook.com/profile.php?id=${targetFbId}`
    console.log(`[CAMPAIGN-INTERACT] Visiting profile: ${profileUrl}`)
    logger.log('visit_profile', { target_type: 'profile', target_id: targetFbId, target_url: profileUrl })
    await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await R.sleepRange(2000, 4000)

    // Browse naturally — simulate reading profile
    await humanMouseMove(page)
    await R.sleepRange(1000, 2000)
    await humanScroll(page)
    await R.sleepRange(1500, 3000)
    await humanScroll(page)
    await R.sleepRange(1000, 2000)

    let liked = 0
    let commented = 0

    // Like some posts
    if (likeCheck.allowed) {
      const maxLikes = getActionParams(parsed_plan, 'like', { countMin: 2, countMax: 5 }).count
      const likeButtons = await page.$$([
        'div[aria-label="Like"]',
        'div[aria-label="Thích"]',
        'div[aria-label="Thich"]',
      ].join(', '))

      const likesToDo = Math.min(maxLikes, likeButtons.length, likeCheck.remaining)

      for (let i = 0; i < likesToDo; i++) {
        try {
          const btn = likeButtons[i]
          const pressed = await btn.getAttribute('aria-pressed').catch(() => null)
          if (pressed === 'true') continue

          await btn.scrollIntoViewIfNeeded()
          await R.sleepRange(500, 1500)
          await btn.click()
          liked++

          await supabase.rpc('increment_budget', {
            p_account_id: account_id,
            p_action_type: 'like',
          })
          logger.log('like', { target_type: 'profile', target_id: targetFbId, target_url: profileUrl })

          await R.sleepRange(3000, 8000)
        } catch (err) {
          // Skip individual errors
        }
      }
    }

    // Optionally comment if config says so
    if (config?.should_comment) {
      const commentBudget = account.daily_budget?.comment || { used: 0, max: 25 }
      const commentCheck = checkHardLimit('comment', commentBudget.used, 0)

      if (commentCheck.allowed) {
        const commentBtn = await page.$([
          'div[aria-label="Leave a comment"]',
          'div[aria-label="Viết bình luận"]',
          'div[aria-label="Comment"]',
          'div[aria-label="Bình luận"]',
        ].join(', '))

        if (commentBtn) {
          try {
            await commentBtn.scrollIntoViewIfNeeded()
            await R.sleepRange(500, 1000)
            await commentBtn.click()
            await R.sleepRange(1000, 2000)

            const commentBox = await page.$('div[contenteditable="true"][role="textbox"]')
            if (commentBox) {
              // Generate AI comment with template fallback
              const text = await generateComment({
                postText: '', // profile context, no specific post
                groupName: '',
                topic: payload.topic || '',
                style: config?.comment_style || 'enthusiastic',
                userId: payload.created_by,
                templates: config?.comment_templates,
                accountId: payload.account_id,
                campaignId: payload.campaign_id,
              })

              await commentBox.click()
              await R.sleepRange(300, 800)
              for (const char of text) {
                await page.keyboard.type(char)
                await R.sleep(R.keyDelay())
              }
              await R.sleepRange(500, 1000)
              await page.keyboard.press('Enter')
              await R.sleepRange(1000, 2000)

              commented++
              await supabase.rpc('increment_budget', {
                p_account_id: account_id,
                p_action_type: 'comment',
              })
              logger.log('comment', { target_type: 'profile', target_id: targetFbId, target_url: profileUrl, details: { comment_text: text.substring(0, 200) } })
            }
          } catch (err) {
            console.warn(`[CAMPAIGN-INTERACT] Comment failed: ${err.message}`)
            logger.log('comment', { target_type: 'profile', target_id: targetFbId, target_url: profileUrl, result_status: 'failed', details: { error: err.message } })
          }
        }
      }
    }

    // Update target_queue if claimed from workflow
    if (claimedTargetId) {
      await supabase.from('target_queue').update({
        status: 'done', processed_at: new Date(),
      }).eq('id', claimedTargetId)
    }

    console.log(`[CAMPAIGN-INTERACT] Done: ${liked} likes, ${commented} comments on profile`)

    // Remember: profile interaction pattern that worked
    if (liked > 0 || commented > 0) {
      try {
        const { remember } = require('../../lib/ai-memory')
        await remember(supabase, {
          campaignId: payload.campaign_id,
          accountId: payload.account_id,
          groupFbId: null,
          memoryType: 'nick_behavior',
          key: 'profile_interaction_pattern',
          value: {
            likes: liked,
            comments: commented,
            style: config?.comment_style || 'enthusiastic',
            topic: payload.topic || '',
          },
          confidence: 0.65,
        })
      } catch (memErr) { /* non-blocking */ }
    }

    return {
      success: true,
      profile_url: profileUrl,
      likes: liked,
      comments: commented,
    }
  } catch (err) {
    if (page) await saveDebugScreenshot(page, `campaign-interact-${account_id}`)
    if (claimedTargetId) {
      try {
        await supabase.from('target_queue').update({
          status: 'failed', error_message: err.message?.substring(0, 200),
        }).eq('id', claimedTargetId)
      } catch (_) {}
    }
    throw err
  } finally {
    await logger.flush().catch(() => {})
    if (page) // Keep page on FB for session reuse
    releaseSession(account_id)
  }
}

module.exports = campaignInteractProfile
