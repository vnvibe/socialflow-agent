/**
 * Post to Facebook Group handler
 * Dùng session pool + human simulation để tránh checkpoint
 */
const { getPage, releaseSession } = require('../../browser/session-pool')
const { delay, humanBrowse, humanMouseMove, humanScroll } = require('../../browser/human')
const {
  checkAccountStatus, openComposer, typeCaption,
  uploadMedia, submitPost, savePublishHistory,
  updateAccountStats, saveDebugScreenshot,
  ensureDailyReset, checkDailyLimit,
  setupPostIdInterceptor, getInterceptedPostId,
} = require('./post-utils')

async function postGroupHandler(payload, supabase) {
  const { content_id, target_id, account_id, campaign_id, spin_mode } = payload

  // Fetch data
  const [{ data: content }, { data: account }, { data: group }] = await Promise.all([
    supabase.from('contents').select('*, media(*)').eq('id', content_id).single(),
    supabase.from('accounts').select('*, proxies(*)').eq('id', account_id).single(),
    supabase.from('fb_groups').select('*').eq('id', target_id).single(),
  ])

  if (!content) throw new Error(`Missing content (id: ${content_id})`)
  if (!account) throw new Error(`Missing account (id: ${account_id})`)
  if (!group) throw new Error(`Missing group (id: ${target_id})`)

  // Daily limit check
  await ensureDailyReset(supabase, account)
  checkDailyLimit(account)

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

    console.log(`[POST-GROUP] Posting to group: ${group.name} (${group.fb_group_id})`)

    // Navigate to group
    await browserPage.goto(`https://www.facebook.com/groups/${group.fb_group_id}`, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    })
    await delay(3000, 5000)

    // Check checkpoint
    const status = await checkAccountStatus(browserPage, supabase, account_id)
    if (status.blocked) {
      await savePublishHistory(supabase, {
        job_id: payload.job_id, content_id, account_id,
        target_type: 'group', target_fb_id: group.fb_group_id,
        target_name: group.name, status: 'failed',
        error_message: status.detail, campaign_id,
      })
      throw new Error(`Account blocked: ${status.detail}`)
    }

    // Giả lập browse trang nhóm trước khi đăng (ngắn thôi, tránh scroll quá xa)
    await humanBrowse(browserPage, 2)
    await humanMouseMove(browserPage)

    // Mở composer
    const composerOpened = await openComposer(browserPage, 'group')
    if (!composerOpened) {
      console.log(`[POST-GROUP] ⚠️ Đéo mở được composer trong nhóm ${group.name} (${group.fb_group_id}). Cập nhật is_member = false và lập lịch check_group_membership để tự động join lại.`)
      
      // 1. Cập nhật DB: nick không phải thành viên nữa
      await supabase.from('fb_groups').update({
        is_member: false,
        pending_approval: false
      }).eq('id', target_id)

      // 2. Tự động lập lịch một job check_group_membership sau 10 phút để kiểm tra lại và tự join lại
      try {
        await supabase.from('jobs').insert({
          type: 'check_group_membership',
          priority: 3,
          payload: {
            campaign_id: campaign_id || null,
            account_id,
            fb_group_id: group.fb_group_id,
            group_row_id: target_id,
            group_url: group.url || `https://www.facebook.com/groups/${group.fb_group_id}`,
            group_name: group.name,
            owner_id: account.owner_id,
            attempt: 1
          },
          status: 'pending',
          scheduled_at: new Date(Date.now() + 10 * 60000).toISOString(), // 10 phút sau
          created_by: account.owner_id
        })
        console.log(`[POST-GROUP] Scheduled check_group_membership in 10min to recover/rejoin group`)
      } catch (jobErr) {
        console.warn(`[POST-GROUP] Failed to schedule membership recovery: ${jobErr.message}`)
      }

      throw new Error(`COMPOSER_NOT_FOUND: Đéo mở được composer trong nhóm. Có thể nick đã bị kích khỏi nhóm hoặc bị chặn viết bài. Trạng thái nhóm đã được reset và lên lịch check/join lại.`)
    }

    // Type caption
    await typeCaption(browserPage, caption)

    // Upload media nếu có
    if (content.media) {
      const mediaUploaded = await uploadMedia(browserPage, content.media, supabase)
      if (!mediaUploaded) {
        console.log('[POST-GROUP] WARNING: Media upload failed — retrying once...')
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
    if (fbPostId) console.log(`[POST-GROUP] Captured fb_post_id: ${fbPostId}`)
    else console.log('[POST-GROUP] WARNING: Could not capture fb_post_id')

    // Save success
    await savePublishHistory(supabase, {
      job_id: payload.job_id, content_id, account_id,
      target_type: 'group', target_fb_id: group.fb_group_id,
      target_name: group.name, caption, status: 'success',
      campaign_id, fb_post_id: fbPostId,
    })

    // Update account stats
    await updateAccountStats(supabase, account_id, account)

    // Update group last_posted_at
    await supabase.from('fb_groups').update({
      last_posted_at: new Date(),
    }).eq('id', target_id)

    // Ghi nhận nếu group yêu cầu duyệt bài
    const needsApproval = group.post_approval_required
    const postUrl = fbPostId
      ? `https://www.facebook.com/groups/${group.fb_group_id}/posts/${fbPostId}`
      : null
    console.log(`[POST-GROUP] Success! Posted to ${group.name}${needsApproval ? ' (pending approval)' : ''}${postUrl ? ` → ${postUrl}` : ''}`)

    return {
      success: true,
      group_name: group.name,
      pending_approval: needsApproval || false,
      post_url: postUrl,
      fb_post_id: fbPostId,
    }

  } catch (err) {
    console.error(`[POST-GROUP] Error posting to ${group?.name}: ${err.message}`)

    if (browserPage) {
      await saveDebugScreenshot(browserPage, `post-group-error-${account_id}`)
    }

    // Marketplace groups — mark as skipped, don't retry
    if (err.message.startsWith('SKIP_MARKETPLACE')) {
      await savePublishHistory(supabase, {
        job_id: payload.job_id, content_id, account_id,
        target_type: 'group', target_fb_id: group?.fb_group_id,
        target_name: group?.name, status: 'skipped',
        error_message: err.message, campaign_id,
      })
      // Return instead of throw — no retry needed
      console.log(`[POST-GROUP] Skipped marketplace group: ${group?.name}`)
      return { success: false, skipped: true, reason: err.message }
    }

    if (!err.message.includes('Account blocked')) {
      await savePublishHistory(supabase, {
        job_id: payload.job_id, content_id, account_id,
        target_type: 'group', target_fb_id: group?.fb_group_id,
        target_name: group?.name, status: 'failed',
        error_message: err.message, campaign_id,
      })
    }

    throw err
  } finally {
    // Keep page on FB for session reuse
    releaseSession(account_id)
  }
}

module.exports = postGroupHandler
