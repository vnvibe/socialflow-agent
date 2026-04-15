/**
 * Comment on a Facebook post handler
 * Navigates to post URL, finds comment box, types comment, submits
 */
const { getPage, releaseSession } = require('../../browser/session-pool')
const { delay, humanBrowse, humanMouseMove } = require('../../browser/human')
const { checkAccountStatus, saveDebugScreenshot } = require('./post-utils')

// Lỗi do điều kiện tạm thời → có thể retry
function isRetryable(err) {
  const msg = err.message || ''
  return (
    msg.includes('Could not find comment input') ||
    msg.includes('timeout') ||
    msg.includes('Timeout') ||
    msg.includes('not focused') ||
    msg.includes('Element is not attached')
  )
}

async function commentPostHandler(payload, supabase) {
  const { account_id, post_url, fb_post_id, comment_text, source_name, job_id } = payload

  if (!account_id || !comment_text) throw new Error('account_id and comment_text required')
  if (!post_url && !fb_post_id) throw new Error('post_url or fb_post_id required')

  const { data: account } = await supabase
    .from('accounts')
    .select('*, proxies(*)')
    .eq('id', account_id)
    .single()

  if (!account) throw new Error('Account not found')

  // Find comment_log: ưu tiên match theo job_id (retry tạo job mới), fallback theo fb_post_id
  const ownerId = account.owner_id
  let commentLogQuery = supabase.from('comment_logs').select('id').eq('owner_id', ownerId).eq('account_id', account_id)
  if (job_id) {
    commentLogQuery = commentLogQuery.eq('job_id', job_id)
  } else {
    commentLogQuery = commentLogQuery.eq('fb_post_id', fb_post_id).eq('status', 'pending')
  }
  const { data: commentLogs } = await commentLogQuery.order('created_at', { ascending: false }).limit(1)
  const commentLogId = commentLogs?.[0]?.id

  const MAX_RETRIES = 2
  let lastErr = null

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      console.log(`[COMMENT-POST] Retry ${attempt}/${MAX_RETRIES} sau ${attempt * 5}s...`)
      await delay(attempt * 5000, attempt * 5000 + 2000)
    }

  let browserPage
  try {
    const session = await getPage(account)
    browserPage = session.page

    let targetUrl = post_url || `https://www.facebook.com/${fb_post_id}`

    // Validate URL — prevent commenting on group wall instead of specific post
    const isGroupUrl = /^https:\/\/www\.facebook\.com\/groups\/[^/]+\/?$/.test(targetUrl)
    if (isGroupUrl) {
      if (fb_post_id && !fb_post_id.startsWith('mobile_') && /^\d+$/.test(fb_post_id)) {
        const gMatch = targetUrl.match(/groups\/([^/?]+)/)
        if (gMatch) {
          targetUrl = `https://www.facebook.com/groups/${gMatch[1]}/posts/${fb_post_id}/`
        } else {
          throw new Error('post_url is group URL without specific post — cannot comment safely')
        }
      } else {
        throw new Error('post_url is group URL without valid post ID — cannot comment safely')
      }
    }

    // Switch to mobile FB — simpler DOM, easier comment box
    targetUrl = targetUrl.replace('://www.facebook.com', '://m.facebook.com')
    console.log(`[COMMENT-POST] Navigating to (mobile): ${targetUrl}`)

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

    // Scroll down to load comments section
    await browserPage.evaluate(() => window.scrollBy(0, Math.floor(window.innerHeight * 0.6)))
    await delay(2000, 3000)

    // Mobile FB: find comment box (textarea or contenteditable)
    console.log('[COMMENT-POST] Looking for comment box (mobile)...')

    const mobileSelectors = [
      'textarea[name="comment_text"]',           // classic mobile FB
      'textarea[data-sigil="comment-body-input"]', // mbasic
      'textarea[placeholder*="bình luận" i]',
      'textarea[placeholder*="comment" i]',
      'div[contenteditable="true"][role="textbox"]', // newer mobile
      'textarea',                                  // last resort
    ]

    let commentBox = null
    for (const sel of mobileSelectors) {
      try {
        const el = await browserPage.$(sel)
        if (el) {
          const visible = await el.isVisible().catch(() => false)
          if (visible) {
            console.log(`[COMMENT-POST] Found comment box: ${sel}`)
            commentBox = el
            break
          }
        }
      } catch {}
    }

    // If no box found, try clicking "Comment" link to reveal it
    if (!commentBox) {
      console.log('[COMMENT-POST] No comment box — clicking comment link...')
      const commentLinks = [
        'a[href*="comment"]',
        'span:has-text("Bình luận")',
        'span:has-text("Comment")',
      ]
      for (const sel of commentLinks) {
        try {
          const link = await browserPage.$(sel)
          if (link && await link.isVisible().catch(() => false)) {
            await link.click({ timeout: 5000 })
            await delay(2000, 3000)
            break
          }
        } catch {}
      }

      // Re-search after clicking
      for (const sel of mobileSelectors) {
        try {
          const el = await browserPage.$(sel)
          if (el && await el.isVisible().catch(() => false)) {
            commentBox = el
            break
          }
        } catch {}
      }
    }

    if (!commentBox) {
      try { await saveDebugScreenshot(browserPage, `comment-no-box-${account_id}`) } catch {}
      throw new Error('Could not find comment input box (mobile)')
    }

    // Focus and type
    await commentBox.scrollIntoViewIfNeeded().catch(() => {})
    await delay(300, 600)
    await commentBox.click({ timeout: 5000 }).catch(async () => {
      await browserPage.evaluate(el => { el.focus(); el.click() }, commentBox)
    })
    await delay(500, 1000)

    // Type comment
    console.log(`[COMMENT-POST] Typing comment (${comment_text.length} chars)...`)

    // Mobile textarea: can use fill() directly for textarea, or type for contenteditable
    const tagName = await browserPage.evaluate(el => el.tagName.toLowerCase(), commentBox)
    if (tagName === 'textarea') {
      await commentBox.fill(comment_text)
      await delay(500, 1000)
    } else {
      for (const char of comment_text) {
        await browserPage.keyboard.type(char, { delay: Math.random() * 80 + 30 })
      }
      await delay(1000, 2000)
    }

    // Submit: try submit button first, then Enter
    console.log('[COMMENT-POST] Submitting comment...')
    const submitSelectors = [
      'button[type="submit"][name="submit"]',   // mbasic
      'button[data-sigil="submit_composer"]',
      'input[type="submit"]',
      'button[type="submit"]',
    ]
    let submitted = false
    for (const sel of submitSelectors) {
      try {
        const btn = await browserPage.$(sel)
        if (btn && await btn.isVisible().catch(() => false)) {
          await btn.click({ timeout: 5000 })
          submitted = true
          console.log(`[COMMENT-POST] Clicked submit: ${sel}`)
          break
        }
      } catch {}
    }
    if (!submitted) {
      await browserPage.keyboard.press('Enter')
    }

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

    // Remember: this comment format worked for this nick
    try {
      const { remember } = require('../../lib/ai-memory')
      if (payload.campaign_id) {
        await remember(supabase, {
          campaignId: payload.campaign_id,
          accountId: account_id,
          groupFbId: payload.fb_group_id || null,
          memoryType: 'nick_behavior',
          key: 'comment_format_works',
          value: {
            length: comment_text.length,
            preview: comment_text.substring(0, 120),
            attempts_needed: attempt + 1,
            source: source_name || 'unknown',
          },
          confidence: 0.7,
        })
      }
    } catch (memErr) { /* non-blocking */ }

    return {
      success: true,
      fb_post_id,
      source_name,
      comment_length: comment_text.length,
      attempts: attempt + 1,
    }

  } catch (err) {
    lastErr = err
    console.error(`[COMMENT-POST] Attempt ${attempt + 1} failed: ${err.message}`)

    // Debug screenshot (best effort)
    if (browserPage) {
      try { await saveDebugScreenshot(browserPage, `comment-error-${account_id}-attempt${attempt}`) } catch {}
    }

  } finally {
    // Keep page on FB for session reuse
    releaseSession(account_id)
  }

  // Nếu không retryable → dừng ngay
  if (!isRetryable(lastErr)) break
  } // end retry loop

  // Tất cả attempts đều thất bại
  if (commentLogId) {
    try {
      await supabase.from('comment_logs').update({
        status: 'failed',
        error_message: lastErr.message.substring(0, 500),
        finished_at: new Date().toISOString(),
      }).eq('id', commentLogId).eq('owner_id', ownerId)
    } catch (_) {}
  }

  throw lastErr
}

module.exports = commentPostHandler
