/**
 * Comment on a Facebook post handler
 * Navigates to post URL, finds comment box, types comment, submits
 */
const { getPage, releaseSession } = require('../../browser/session-pool')
const { delay, humanBrowse, humanMouseMove } = require('../../browser/human')
const { checkAccountStatus, saveDebugScreenshot } = require('./post-utils')

async function commentPostHandler(payload, supabase) {
  const { account_id, post_url, fb_post_id, comment_text, source_name } = payload

  if (!account_id || !comment_text) throw new Error('account_id and comment_text required')
  if (!post_url && !fb_post_id) throw new Error('post_url or fb_post_id required')

  const { data: account } = await supabase
    .from('accounts')
    .select('*, proxies(*)')
    .eq('id', account_id)
    .single()

  if (!account) throw new Error('Account not found')

  // Find comment_log linked to this job to update status (scope by owner_id for multi-user safety)
  const ownerId = account.owner_id
  const { data: commentLogs } = await supabase
    .from('comment_logs')
    .select('id')
    .eq('owner_id', ownerId)
    .eq('fb_post_id', fb_post_id)
    .eq('account_id', account_id)
    .eq('status', 'pending')
    .order('created_at', { ascending: false })
    .limit(1)

  const commentLogId = commentLogs?.[0]?.id

  let browserPage
  try {
    const session = await getPage(account)
    browserPage = session.page

    let targetUrl = post_url || `https://www.facebook.com/${fb_post_id}`

    // Validate URL — prevent commenting on group wall instead of specific post
    const isGroupUrl = /^https:\/\/www\.facebook\.com\/groups\/[^/]+\/?$/.test(targetUrl)
    if (isGroupUrl) {
      // Try to build URL from fb_post_id
      if (fb_post_id && !fb_post_id.startsWith('mobile_') && /^\d+$/.test(fb_post_id)) {
        const gMatch = targetUrl.match(/groups\/([^/?]+)/)
        if (gMatch) {
          targetUrl = `https://www.facebook.com/groups/${gMatch[1]}/posts/${fb_post_id}/`
          console.log(`[COMMENT-POST] Fixed group URL → ${targetUrl}`)
        } else {
          throw new Error('post_url is group URL without specific post — cannot comment safely')
        }
      } else {
        throw new Error('post_url is group URL without valid post ID — cannot comment safely')
      }
    }

    console.log(`[COMMENT-POST] Navigating to: ${targetUrl}`)

    await browserPage.goto(targetUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    })
    await delay(3000, 5000)

    // Verify we are on a single post page, not a group feed
    const pageUrl = browserPage.url()
    if (/\/groups\/[^/]+\/?(\?|$)/.test(pageUrl) && !pageUrl.includes('/posts/') && !pageUrl.includes('/permalink/')) {
      throw new Error('Navigated to group feed instead of single post — aborting to prevent wall post')
    }

    // Check for "content not available" page
    const pageText = await browserPage.evaluate(() => document.body?.innerText?.substring(0, 200) || '')
    if (pageText.includes('không xem được') || pageText.includes('not available') || pageText.includes('content isn')) {
      throw new Error('Post not available — may be deleted or restricted')
    }

    // Check checkpoint
    const status = await checkAccountStatus(browserPage, supabase, account_id)
    if (status.blocked) {
      throw new Error(`Account blocked: ${status.detail}`)
    }

    // Simulate reading the post before commenting — like a real person
    await humanMouseMove(browserPage)
    await delay(1500, 3000)
    // Scroll down slightly to read the full post
    await browserPage.evaluate(() => window.scrollBy(0, Math.floor(Math.random() * 300 + 100)))
    await delay(2000, 4000)
    // Random mouse move while "reading"
    await humanMouseMove(browserPage)
    await delay(1000, 2000)

    // Find and click the comment input area
    console.log('[COMMENT-POST] Looking for comment box...')

    // Try multiple selectors for comment box
    const commentBoxSelectors = [
      'div[contenteditable="true"][aria-label*="comment" i]',
      'div[contenteditable="true"][aria-label*="bình luận" i]',
      'div[contenteditable="true"][aria-label*="Write" i]',
      'div[contenteditable="true"][aria-label*="Viết" i]',
      'div[contenteditable="true"][role="textbox"][aria-label*="comment" i]',
      // Fallback: click "Write a comment" placeholder text
      '[aria-label*="Write a comment"]',
      '[aria-label*="Viết bình luận"]',
    ]

    let commentBox = null
    for (const selector of commentBoxSelectors) {
      commentBox = await browserPage.$(selector)
      if (commentBox) {
        console.log(`[COMMENT-POST] Found comment box with: ${selector}`)
        break
      }
    }

    if (!commentBox) {
      // Try scrolling down to load comments section
      await browserPage.evaluate(() => window.scrollBy(0, 500))
      await delay(2000, 3000)

      // Try clicking "Comment" button area to open comment box
      const commentBtnSelectors = [
        'div[aria-label="Leave a comment"]',
        'div[aria-label="Viết bình luận"]',
        'span:has-text("Comment")',
        'span:has-text("Bình luận")',
      ]

      for (const selector of commentBtnSelectors) {
        try {
          const btn = await browserPage.$(selector)
          if (btn) {
            await btn.click()
            await delay(1000, 2000)
            break
          }
        } catch {}
      }

      // Try finding comment box again after clicking
      for (const selector of commentBoxSelectors) {
        commentBox = await browserPage.$(selector)
        if (commentBox) break
      }
    }

    if (!commentBox) {
      try { await saveDebugScreenshot(browserPage, `comment-no-box-${account_id}`) } catch {}
      throw new Error('Could not find comment input box')
    }

    // Click to focus
    await commentBox.click()
    await delay(500, 1000)

    // Type comment with human-like delays
    console.log(`[COMMENT-POST] Typing comment (${comment_text.length} chars)...`)
    for (const char of comment_text) {
      await browserPage.keyboard.type(char, { delay: Math.random() * 80 + 30 })
    }
    await delay(1000, 2000)

    // Submit with Enter
    console.log('[COMMENT-POST] Submitting comment...')
    await browserPage.keyboard.press('Enter')

    // Wait for comment to appear — like a real person checking their comment posted
    await delay(3000, 5000)

    // Scroll slightly to see the comment area
    await browserPage.evaluate(() => window.scrollBy(0, Math.floor(Math.random() * 150 + 50)))
    await delay(1500, 3000)

    // Random mouse movement — looking at the posted comment
    await humanMouseMove(browserPage)
    await delay(2000, 4000)

    // Sometimes scroll back up a bit, like re-reading the post
    if (Math.random() < 0.4) {
      await browserPage.evaluate(() => window.scrollBy(0, -Math.floor(Math.random() * 100 + 30)))
      await delay(1000, 2000)
    }

    // Final pause before leaving — like lingering on the page
    await delay(2000, 4000)

    // Update comment_log status to done (scope by owner_id)
    if (commentLogId) {
      await supabase.from('comment_logs').update({
        status: 'done',
        finished_at: new Date().toISOString(),
      }).eq('id', commentLogId).eq('owner_id', ownerId)
    }

    console.log(`[COMMENT-POST] Success! Commented on ${source_name || fb_post_id}`)

    return {
      success: true,
      fb_post_id,
      source_name,
      comment_length: comment_text.length,
    }

  } catch (err) {
    console.error(`[COMMENT-POST] Error: ${err.message}`)

    // Update comment_log FIRST (scope by owner_id)
    if (commentLogId) {
      await supabase.from('comment_logs').update({
        status: 'failed',
        error_message: err.message.substring(0, 500),
        finished_at: new Date().toISOString(),
      }).eq('id', commentLogId).eq('owner_id', ownerId).catch(() => {})
    }

    // Debug screenshot (best effort)
    if (browserPage) {
      try { await saveDebugScreenshot(browserPage, `comment-error-${account_id}`) } catch {}
    }

    throw err
  } finally {
    if (browserPage) await browserPage.close().catch(() => {})
    releaseSession(account_id)
  }
}

module.exports = commentPostHandler
