/**
 * Check engagement handler
 * Kiểm tra reactions, comments, shares cho các bài viết
 */
const { getPage, releaseSession } = require('../../browser/session-pool')
const { delay, humanBrowse, humanMouseMove } = require('../../browser/human')
const { checkAccountStatus, saveDebugScreenshot } = require('./post-utils')

async function checkEngagementHandler(payload, supabase) {
  const { account_id, post_ids, owner_id } = payload

  if (!account_id) throw new Error('account_id required')
  if (!post_ids?.length) throw new Error('post_ids required')

  // Get account
  const { data: account } = await supabase.from('accounts').select('*, proxies(*)')
    .eq('id', account_id).single()
  if (!account) throw new Error('Account not found')

  let browserPage
  let checked = 0
  let updated = 0

  try {
    const session = await getPage(account)
    browserPage = session.page

    console.log(`[ENGAGEMENT] Checking engagement for ${post_ids.length} posts`)

    // Check checkpoint first
    await browserPage.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 30000 })
    await delay(2000, 4000)
    const status = await checkAccountStatus(browserPage, supabase, account_id)
    if (status.blocked) throw new Error(`Account blocked: ${status.detail}`)

    for (const postInfo of post_ids) {
      try {
        const { fb_post_id, source_type, source_id } = postInfo
        if (!fb_post_id) continue

        console.log(`[ENGAGEMENT] Checking post: ${fb_post_id} (${source_type})`)

        // Navigate to post
        const postUrl = `https://www.facebook.com/${fb_post_id}`
        await browserPage.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 20000 })
        await delay(2000, 4000)

        // Check if redirected
        const currentUrl = browserPage.url()
        if (currentUrl.includes('/login') || currentUrl.includes('/checkpoint')) {
          console.log(`[ENGAGEMENT] Redirected for post ${fb_post_id}, skipping`)
          continue
        }

        // Brief browse
        await humanBrowse(browserPage, 1)

        // Extract engagement data
        const engagement = await extractEngagement(browserPage)
        checked++

        console.log(`[ENGAGEMENT] Post ${fb_post_id}: ${engagement.reactions} reactions, ${engagement.comments} comments, ${engagement.shares} shares`)

        // Save engagement snapshot
        await supabase.from('engagement_snapshots').insert({
          owner_id,
          source_type,
          source_id,
          fb_post_id,
          reactions: engagement.reactions,
          comments: engagement.comments,
          shares: engagement.shares,
          checked_at: new Date().toISOString(),
        })

        // Update source record with latest engagement
        if (source_type === 'own_post' && source_id) {
          await supabase.from('publish_history').update({
            reactions: engagement.reactions,
            comments: engagement.comments,
            shares: engagement.shares,
          }).eq('id', source_id)
          updated++
        } else if (source_type === 'discovered_post' && source_id) {
          await supabase.from('discovered_posts').update({
            reactions: engagement.reactions,
            comments: engagement.comments,
            shares: engagement.shares,
          }).eq('id', source_id)
          updated++
        }

        // Random delay between posts
        if (post_ids.indexOf(postInfo) < post_ids.length - 1) {
          await delay(2000, 4000)
          if (Math.random() < 0.2) await humanMouseMove(browserPage)
        }

      } catch (err) {
        console.error(`[ENGAGEMENT] Error checking post ${postInfo.fb_post_id}: ${err.message}`)
        // Continue with next post
      }
    }

    console.log(`[ENGAGEMENT] Done! Checked ${checked}/${post_ids.length}, updated ${updated}`)
    return { checked, updated, total: post_ids.length }

  } catch (err) {
    console.error(`[ENGAGEMENT] Error: ${err.message}`)
    if (browserPage) await saveDebugScreenshot(browserPage, `engagement-error-${account_id}`)
    throw err
  } finally {
    if (browserPage) await browserPage.close().catch(() => {})
    releaseSession(account_id)
  }
}

/**
 * Extract engagement counts from a post page
 */
async function extractEngagement(page) {
  return await page.evaluate(() => {
    const body = document.body?.innerText || ''
    let reactions = 0, comments = 0, shares = 0

    function parseCount(str) {
      if (!str) return 0
      str = str.replace(/,/g, '.').trim()
      if (/[kK]$/.test(str) || /\s*[kK]\s/.test(str)) return Math.round(parseFloat(str) * 1000)
      if (/[mM]$/.test(str) || /\s*[mM]\s/.test(str)) return Math.round(parseFloat(str) * 1000000)
      return parseInt(str.replace(/\./g, '')) || 0
    }

    // Strategy 1: Look for aria-label attributes with engagement data
    const reactionLabels = document.querySelectorAll('[aria-label*="reaction"], [aria-label*="cảm xúc"], [aria-label*="like"], [aria-label*="thích"]')
    for (const el of reactionLabels) {
      const label = el.getAttribute('aria-label') || ''
      const m = label.match(/(\d+(?:[\.,]\d+)?[KkMm]?)/)
      if (m) {
        const val = parseCount(m[1])
        if (val > reactions) reactions = val
      }
    }

    // Strategy 2: Regex from body text
    // Reactions: "X reactions" or "X lượt thích" or "X cảm xúc" or just a number near emoji
    const reactionPatterns = [
      /(\d+(?:[\.,]\d+)?[KkMm]?)\s*(?:reactions?|lượt thích|cảm xúc)/i,
      /(?:reactions?|lượt thích|cảm xúc)\s*[:.]?\s*(\d+(?:[\.,]\d+)?[KkMm]?)/i,
    ]
    for (const pattern of reactionPatterns) {
      const m = body.match(pattern)
      if (m) {
        const val = parseCount(m[1])
        if (val > reactions) reactions = val
      }
    }

    // Comments
    const commentPatterns = [
      /(\d+(?:[\.,]\d+)?[KkMm]?)\s*(?:comments?|bình luận)/i,
      /(?:comments?|bình luận)\s*[:.]?\s*(\d+(?:[\.,]\d+)?[KkMm]?)/i,
    ]
    for (const pattern of commentPatterns) {
      const m = body.match(pattern)
      if (m) {
        const val = parseCount(m[1])
        if (val > comments) comments = val
      }
    }

    // Shares
    const sharePatterns = [
      /(\d+(?:[\.,]\d+)?[KkMm]?)\s*(?:shares?|chia sẻ|lượt chia sẻ)/i,
      /(?:shares?|chia sẻ|lượt chia sẻ)\s*[:.]?\s*(\d+(?:[\.,]\d+)?[KkMm]?)/i,
    ]
    for (const pattern of sharePatterns) {
      const m = body.match(pattern)
      if (m) {
        const val = parseCount(m[1])
        if (val > shares) shares = val
      }
    }

    // Strategy 3: Look for specific engagement bar elements
    // Facebook often has a toolbar-like section near the bottom of the post
    const engToolbar = document.querySelector('[role="toolbar"]') ||
                        document.querySelector('[data-testid="UFI2TopReactions/root"]')
    if (engToolbar) {
      const toolText = engToolbar.innerText || ''
      const nums = toolText.match(/\d+(?:[\.,]\d+)?[KkMm]?/g)
      if (nums?.length >= 1 && !reactions) reactions = parseCount(nums[0])
      if (nums?.length >= 2 && !comments) comments = parseCount(nums[1])
      if (nums?.length >= 3 && !shares) shares = parseCount(nums[2])
    }

    return { reactions, comments, shares }
  })
}

module.exports = checkEngagementHandler
