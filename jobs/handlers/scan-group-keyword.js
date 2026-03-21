/**
 * Scan group posts by keyword handler
 * Quét bài viết trong group theo từ khoá, lưu vào discovered_posts
 */
const { getPage, releaseSession } = require('../../browser/session-pool')
const { delay, humanScroll, humanMouseMove, humanBrowse } = require('../../browser/human')
const { checkAccountStatus, saveDebugScreenshot } = require('./post-utils')

async function scanGroupKeywordHandler(payload, supabase) {
  const { account_id, keyword, keyword_id, group_ids, time_window_hours, owner_id } = payload

  if (!keyword) throw new Error('keyword required')
  if (!account_id) throw new Error('account_id required')

  // Get account
  const { data: account } = await supabase.from('accounts').select('*, proxies(*)')
    .eq('id', account_id).single()
  if (!account) throw new Error('Account not found')

  // If no specific group_ids, get all groups for this account
  let targetGroups = group_ids || []
  if (targetGroups.length === 0) {
    const { data: groups } = await supabase.from('fb_groups').select('fb_group_id, name')
      .eq('account_id', account_id)
    targetGroups = groups?.map(g => g.fb_group_id) || []
  }

  if (targetGroups.length === 0) {
    console.log('[SCAN-GROUP] No groups to scan')
    return { total_found: 0, new_posts: 0, groups_scanned: 0 }
  }

  let browserPage
  let totalFound = 0
  let newPosts = 0
  let groupsScanned = 0

  try {
    const session = await getPage(account)
    browserPage = session.page

    console.log(`[SCAN-GROUP] Scanning ${targetGroups.length} groups for keyword: "${keyword}"`)

    // Check checkpoint first
    await browserPage.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 30000 })
    await delay(2000, 4000)
    const status = await checkAccountStatus(browserPage, supabase, account_id)
    if (status.blocked) throw new Error(`Account blocked: ${status.detail}`)

    // Calculate time window cutoff
    const cutoffTime = new Date(Date.now() - (time_window_hours || 24) * 3600 * 1000)

    for (const groupId of targetGroups) {
      try {
        console.log(`[SCAN-GROUP] Scanning group: ${groupId} for "${keyword}"`)

        // Navigate to group search
        const searchUrl = `https://www.facebook.com/groups/${groupId}/search/?q=${encodeURIComponent(keyword)}`
        await browserPage.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })
        await delay(3000, 5000)

        // Check if we're still on the right page
        const currentUrl = browserPage.url()
        if (currentUrl.includes('/login') || currentUrl.includes('/checkpoint')) {
          console.log(`[SCAN-GROUP] Redirected away from group, skipping: ${groupId}`)
          continue
        }

        // Simulate browsing
        await humanBrowse(browserPage, 2)

        // Scroll and collect posts
        const posts = await scrollAndExtractPosts(browserPage, keyword, cutoffTime)
        totalFound += posts.length
        groupsScanned++

        console.log(`[SCAN-GROUP] Found ${posts.length} posts in group ${groupId}`)

        // Get group name
        let groupName = null
        const { data: groupData } = await supabase.from('fb_groups').select('name')
          .eq('fb_group_id', groupId).limit(1).single()
        groupName = groupData?.name

        // Upsert discovered posts
        for (const post of posts) {
          try {
            const { error } = await supabase.from('discovered_posts').upsert({
              owner_id,
              keyword_id,
              fb_post_id: post.fb_post_id,
              fb_group_id: groupId,
              group_name: groupName || post.group_name,
              author_name: post.author_name,
              author_fb_id: post.author_fb_id,
              content_text: post.content_text,
              post_url: post.post_url,
              reactions: post.reactions || 0,
              comments: post.comments || 0,
              shares: post.shares || 0,
              posted_at: post.posted_at,
              discovered_at: new Date().toISOString(),
            }, { onConflict: 'owner_id,fb_post_id', ignoreDuplicates: true })

            if (!error) newPosts++
          } catch (e) {
            console.log(`[SCAN-GROUP] Upsert error: ${e.message}`)
          }
        }

        // Random delay between groups (human-like)
        if (targetGroups.indexOf(groupId) < targetGroups.length - 1) {
          await delay(3000, 6000)
          if (Math.random() < 0.3) await humanBrowse(browserPage, 2)
        }

      } catch (err) {
        console.error(`[SCAN-GROUP] Error scanning group ${groupId}: ${err.message}`)
        // Continue with next group
      }
    }

    console.log(`[SCAN-GROUP] Done! Scanned ${groupsScanned} groups, found ${totalFound} posts, ${newPosts} new`)
    return { total_found: totalFound, new_posts: newPosts, groups_scanned: groupsScanned }

  } catch (err) {
    console.error(`[SCAN-GROUP] Error: ${err.message}`)
    if (browserPage) await saveDebugScreenshot(browserPage, `scan-group-error-${account_id}`)
    throw err
  } finally {
    if (browserPage) await browserPage.close().catch(() => {})
    releaseSession(account_id)
  }
}

/**
 * Scroll trang search kết quả và extract posts
 */
async function scrollAndExtractPosts(page, keyword, cutoffTime) {
  const posts = []
  const seen = new Set()
  let noNewCount = 0
  const MAX_SCROLLS = 30
  const MAX_NO_NEW = 4

  for (let i = 0; i < MAX_SCROLLS; i++) {
    // Extract posts từ DOM
    const extracted = await page.evaluate((kw) => {
      const results = []
      // Facebook search results are typically in role="feed" or main content
      const feedArea = document.querySelector('[role="feed"]') || document.querySelector('[role="main"]') || document.body

      // Find post containers — look for links that have post-like structure
      const postLinks = feedArea.querySelectorAll('a[href*="/posts/"], a[href*="/permalink/"], a[href*="story_fbid"]')

      for (const link of postLinks) {
        // Walk up to find the post container (usually 4-6 levels up)
        let container = link
        for (let j = 0; j < 8; j++) {
          if (!container.parentElement) break
          container = container.parentElement
          // Post container usually has data attributes or is a div with substantial content
          if (container.getAttribute('role') === 'article' ||
              container.classList.length > 0 && container.innerText?.length > 50) {
            break
          }
        }

        const text = container?.innerText || ''
        if (text.length < 20) continue
        // Check if content mentions keyword (case insensitive)
        if (!text.toLowerCase().includes(kw.toLowerCase())) continue

        const href = link.href || ''
        // Extract post ID from URL
        let fbPostId = null
        const postMatch = href.match(/\/posts\/(\d+)/) || href.match(/story_fbid=(\d+)/) || href.match(/permalink\/(\d+)/)
        if (postMatch) fbPostId = postMatch[1]
        if (!fbPostId) continue

        // Extract author: usually the first strong or heading link in the container
        let authorName = null
        let authorFbId = null
        const authorLink = container.querySelector('a[role="link"] strong, h2 a, h3 a, h4 a')
        if (authorLink) {
          authorName = authorLink.textContent?.trim()
          const authorHref = authorLink.closest('a')?.href || ''
          const authorMatch = authorHref.match(/facebook\.com\/(?:profile\.php\?id=)?(\d+)/) || authorHref.match(/facebook\.com\/([^/?]+)/)
          if (authorMatch) authorFbId = authorMatch[1]
        }

        // Extract engagement counts
        let reactions = 0, comments = 0, shares = 0
        // Look for engagement bar — usually contains numbers near emoji or "comment" text
        const engText = text.match(/(\d+(?:[\.,]\d+)?[KkMm]?)\s*(?:reactions?|lượt thích|cảm xúc)/i)
        const comText = text.match(/(\d+(?:[\.,]\d+)?[KkMm]?)\s*(?:comments?|bình luận)/i)
        const shareText = text.match(/(\d+(?:[\.,]\d+)?[KkMm]?)\s*(?:shares?|chia sẻ|lượt chia sẻ)/i)

        function parseCount(str) {
          if (!str) return 0
          str = str.replace(/,/g, '.')
          if (/[kK]/.test(str)) return Math.round(parseFloat(str) * 1000)
          if (/[mM]/.test(str)) return Math.round(parseFloat(str) * 1000000)
          return parseInt(str) || 0
        }

        if (engText) reactions = parseCount(engText[1])
        if (comText) comments = parseCount(comText[1])
        if (shareText) shares = parseCount(shareText[1])

        // Extract content text (first 1000 chars, skip author/engagement lines)
        const contentLines = text.split('\n').filter(l => l.length > 10).slice(0, 10)
        const contentText = contentLines.join('\n').substring(0, 1000)

        results.push({
          fb_post_id: fbPostId,
          author_name: authorName,
          author_fb_id: authorFbId,
          content_text: contentText,
          post_url: href.split('?')[0],
          reactions,
          comments,
          shares,
        })
      }

      return results
    }, keyword)

    // Add new posts
    let hasNew = false
    for (const post of extracted) {
      if (!seen.has(post.fb_post_id)) {
        seen.add(post.fb_post_id)
        posts.push(post)
        hasNew = true
      }
    }

    if (hasNew) {
      noNewCount = 0
    } else {
      noNewCount++
      if (noNewCount >= MAX_NO_NEW) break
    }

    // Scroll
    await humanScroll(page)
    await delay(1500, 3000)

    // Random mouse move
    if (Math.random() < 0.3) await humanMouseMove(page)
  }

  return posts
}

module.exports = scanGroupKeywordHandler
