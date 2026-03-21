/**
 * Post to Facebook Personal Profile handler
 * Dùng session pool + human simulation để tránh checkpoint
 */
const { getPage, releaseSession } = require('../../browser/session-pool')
const { delay, humanBrowse, humanMouseMove } = require('../../browser/human')
const {
  checkAccountStatus, openComposer, typeCaption,
  uploadMedia, submitPost, savePublishHistory,
  updateAccountStats, saveDebugScreenshot,
  setupPostIdInterceptor, getInterceptedPostId,
} = require('./post-utils')

async function postProfileHandler(payload, supabase) {
  const { content_id, account_id, campaign_id, spin_mode } = payload

  // Fetch data
  const [{ data: content }, { data: account }] = await Promise.all([
    supabase.from('contents').select('*, media(*)').eq('id', content_id).single(),
    supabase.from('accounts').select('*, proxies(*)').eq('id', account_id).single(),
  ])

  if (!content || !account) throw new Error('Missing content or account')

  // Prepare caption (apply spin if needed)
  let caption = content.caption || ''
  if (spin_mode === 'basic' && content.spin_template) {
    caption = content.spin_template.replace(/\{([^}]+)\}/g, (_, opts) => {
      const options = opts.split('|')
      return options[Math.floor(Math.random() * options.length)]
    })
  }

  // Append hashtags
  if (content.hashtags?.length) {
    caption += '\n\n' + content.hashtags.map(h => h.startsWith('#') ? h : `#${h}`).join(' ')
  }

  let browserPage
  try {
    const session = await getPage(account)
    browserPage = session.page

    console.log(`[POST-PROFILE] Posting to profile: ${account.username || account.fb_user_id}`)

    // Navigate to homepage
    await browserPage.goto('https://www.facebook.com/', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    })
    await delay(3000, 5000)

    // Check checkpoint
    const status = await checkAccountStatus(browserPage, supabase, account_id)
    if (status.blocked) {
      await savePublishHistory(supabase, {
        job_id: payload.job_id, content_id, account_id,
        target_type: 'profile', target_fb_id: account.fb_user_id,
        target_name: account.username, status: 'failed',
        error_message: status.detail, campaign_id,
      })
      throw new Error(`Account blocked: ${status.detail}`)
    }

    // Giả lập browse newsfeed trước khi đăng
    await humanBrowse(browserPage, 3)
    // Scroll lên đầu trang (composer ở trên)
    await browserPage.evaluate(() => window.scrollTo(0, 0))
    await delay(1000, 2000)
    await humanMouseMove(browserPage)

    // Mở composer
    await openComposer(browserPage, 'profile')

    // Type caption
    await typeCaption(browserPage, caption)

    // Upload media nếu có
    if (content.media) {
      const mediaUploaded = await uploadMedia(browserPage, content.media, supabase)
      if (!mediaUploaded) {
        console.log('[POST-PROFILE] WARNING: Media upload failed — retrying once...')
        await delay(2000, 3000)
        const retry = await uploadMedia(browserPage, content.media, supabase)
        if (!retry) {
          throw new Error('Khong the tai anh/video len. Vui long thu lai.')
        }
      }
    }

    // Setup GraphQL interceptor BEFORE submit to capture post ID
    const interceptor = setupPostIdInterceptor(browserPage)

    // Submit post
    await submitPost(browserPage)

    // Wait & capture fb_post_id from GraphQL response
    await delay(2000, 4000)
    const fbPostId = await getInterceptedPostId(browserPage, interceptor, 10000)
    if (fbPostId) console.log(`[POST-PROFILE] Captured fb_post_id: ${fbPostId}`)
    else console.log('[POST-PROFILE] WARNING: Could not capture fb_post_id')

    // Save success
    await savePublishHistory(supabase, {
      job_id: payload.job_id, content_id, account_id,
      target_type: 'profile', target_fb_id: account.fb_user_id,
      target_name: account.username, caption, status: 'success',
      campaign_id, fb_post_id: fbPostId,
    })

    // Update account stats
    await updateAccountStats(supabase, account_id, account)

    const postUrl = fbPostId ? `https://www.facebook.com/${fbPostId}` : null
    console.log(`[POST-PROFILE] Success! Posted to ${account.username || account.fb_user_id}${postUrl ? ` → ${postUrl}` : ''}`)
    return { success: true, username: account.username, post_url: postUrl, fb_post_id: fbPostId }

  } catch (err) {
    console.error(`[POST-PROFILE] Error posting to profile: ${err.message}`)

    if (browserPage) {
      await saveDebugScreenshot(browserPage, `post-profile-error-${account_id}`)
    }

    if (!err.message.includes('Account blocked')) {
      await savePublishHistory(supabase, {
        job_id: payload.job_id, content_id, account_id,
        target_type: 'profile', target_fb_id: account?.fb_user_id,
        target_name: account?.username, status: 'failed',
        error_message: err.message, campaign_id,
      })
    }

    throw err
  } finally {
    if (browserPage) await browserPage.close().catch(() => {})
    releaseSession(account_id)
  }
}

module.exports = postProfileHandler
