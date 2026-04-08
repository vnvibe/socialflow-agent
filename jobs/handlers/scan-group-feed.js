/**
 * Scan group feed handler
 * Vào feed group → scroll lấy bài mới → gửi AI review → lưu bài liên quan
 */
const { getPage, releaseSession } = require('../../browser/session-pool')
const { delay, humanScroll, humanMouseMove, humanBrowse } = require('../../browser/human')
const { checkAccountStatus, saveDebugScreenshot } = require('./post-utils')

const API_BASE = process.env.API_URL || 'https://socialflow-production-d02c.up.railway.app'
const AGENT_KEY = process.env.AGENT_SECRET_KEY || ''

async function scanGroupFeedHandler(payload, supabase) {
  const { account_id, keyword_id, group_ids, topics, owner_id } = payload

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
    console.log('[SCAN-FEED] No groups to scan')
    return { total_found: 0, new_posts: 0, groups_scanned: 0, ai_reviewed: 0 }
  }

  let browserPage
  let totalFound = 0
  let newPosts = 0
  let groupsScanned = 0
  let aiReviewed = 0

  try {
    const session = await getPage(account)
    browserPage = session.page

    console.log(`[SCAN-FEED] Scanning ${targetGroups.length} group feeds`)

    // Check checkpoint first
    await browserPage.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 30000 })
    await delay(2000, 4000)
    const status = await checkAccountStatus(browserPage, supabase, account_id)
    if (status.blocked) throw new Error(`Account blocked: ${status.detail}`)

    for (const groupId of targetGroups) {
      try {
        console.log(`[SCAN-FEED] Scanning feed: ${groupId}`)

        // Navigate to group feed (NOT search — just the main feed)
        await browserPage.goto(`https://www.facebook.com/groups/${groupId}`, {
          waitUntil: 'domcontentloaded', timeout: 30000
        })
        await delay(3000, 5000)

        // Check redirect
        const currentUrl = browserPage.url()
        if (currentUrl.includes('/login') || currentUrl.includes('/checkpoint')) {
          console.log(`[SCAN-FEED] Redirected away from group, skipping: ${groupId}`)
          continue
        }

        // Simulate browsing
        await humanBrowse(browserPage, 2)

        // Scroll and collect ALL posts (no keyword filter)
        const posts = await scrollAndExtractFeedPosts(browserPage)
        totalFound += posts.length
        groupsScanned++

        console.log(`[SCAN-FEED] Found ${posts.length} posts in group ${groupId}`)

        if (posts.length === 0) {
          await delay(2000, 4000)
          continue
        }

        // Dedup: check which posts already exist in DB
        const fbPostIds = posts.map(p => p.fb_post_id).filter(Boolean)
        const { data: existing } = await supabase
          .from('discovered_posts')
          .select('fb_post_id')
          .eq('owner_id', owner_id)
          .in('fb_post_id', fbPostIds)

        const existingIds = new Set((existing || []).map(e => e.fb_post_id))
        const newPostsList = posts.filter(p => p.fb_post_id && !existingIds.has(p.fb_post_id))

        console.log(`[SCAN-FEED] ${newPostsList.length} new posts (${existingIds.size} already in DB)`)

        if (newPostsList.length === 0) {
          await delay(2000, 4000)
          continue
        }

        // Get group name
        let groupName = null
        const { data: groupData } = await supabase.from('fb_groups').select('name')
          .eq('fb_group_id', groupId).eq('account_id', account_id).limit(1).single()
        groupName = groupData?.name

        // AI Review if topics available
        let reviewResults = null
        const effectiveTopics = topics && topics.length > 0 ? topics : null

        if (effectiveTopics && AGENT_KEY) {
          try {
            console.log(`[SCAN-FEED] Sending ${newPostsList.length} posts for AI review...`)
            const response = await fetch(`${API_BASE}/monitor/ai-review`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'X-Agent-Key': AGENT_KEY,
              },
              body: JSON.stringify({
                owner_id,
                topics: effectiveTopics,
                posts: newPostsList.map(p => ({
                  fb_post_id: p.fb_post_id,
                  content_text: p.content_text,
                })),
                min_score: 3,
              }),
            })

            if (response.ok) {
              const data = await response.json()
              reviewResults = new Map()
              for (const r of (data.reviews || [])) {
                reviewResults.set(r.fb_post_id, r)
              }
              aiReviewed = reviewResults.size
              console.log(`[SCAN-FEED] AI reviewed ${aiReviewed} posts, ${data.passing || 0} passed`)
            } else {
              console.log(`[SCAN-FEED] AI review failed: ${response.status}`)
            }
          } catch (aiErr) {
            console.log(`[SCAN-FEED] AI review error: ${aiErr.message}`)
          }
        }

        // Save posts to DB
        for (const post of newPostsList) {
          try {
            // If AI reviewed, only save posts that pass threshold (score >= 3)
            // If no AI review, save all posts
            let relevanceScore = null
            let aiSummary = null

            if (reviewResults) {
              const review = reviewResults.get(post.fb_post_id)
              if (review) {
                relevanceScore = review.relevance_score
                aiSummary = review.ai_summary
                // Skip posts that don't pass
                if (!review.passes) continue
              } else {
                // AI didn't review this post — skip it if topics are set
                continue
              }
            }

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
              relevance_score: relevanceScore,
              ai_summary: aiSummary,
              discovered_at: new Date().toISOString(),
            }, { onConflict: 'owner_id,fb_post_id', ignoreDuplicates: true })

            if (!error) newPosts++
          } catch (e) {
            console.log(`[SCAN-FEED] Upsert error: ${e.message}`)
          }
        }

        // Random delay between groups (human-like)
        if (targetGroups.indexOf(groupId) < targetGroups.length - 1) {
          await delay(3000, 6000)
          if (Math.random() < 0.3) await humanBrowse(browserPage, 2)
        }

      } catch (err) {
        console.error(`[SCAN-FEED] Error scanning group ${groupId}: ${err.message}`)
      }
    }

    console.log(`[SCAN-FEED] Done! Scanned ${groupsScanned} groups, found ${totalFound} posts, ${newPosts} saved, ${aiReviewed} AI-reviewed`)
    return { total_found: totalFound, new_posts: newPosts, groups_scanned: groupsScanned, ai_reviewed: aiReviewed }

  } catch (err) {
    console.error(`[SCAN-FEED] Error: ${err.message}`)
    if (browserPage) await saveDebugScreenshot(browserPage, `scan-feed-error-${account_id}`)
    throw err
  } finally {
    // Keep page on FB for session reuse
    releaseSession(account_id)
  }
}

/**
 * Scroll group feed and extract ALL posts (no keyword filter)
 */
async function scrollAndExtractFeedPosts(page) {
  const posts = []
  const seen = new Set()
  let noNewCount = 0
  const MAX_SCROLLS = 25
  const MAX_NO_NEW = 4

  for (let i = 0; i < MAX_SCROLLS; i++) {
    // Extract posts from DOM
    const extracted = await page.evaluate(() => {
      const results = []
      const feedArea = document.querySelector('[role="feed"]') || document.querySelector('[role="main"]') || document.body

      // Find post containers
      const postLinks = feedArea.querySelectorAll('a[href*="/posts/"], a[href*="/permalink/"], a[href*="story_fbid"]')

      for (const link of postLinks) {
        // Walk up to find the post container
        let container = link
        for (let j = 0; j < 8; j++) {
          if (!container.parentElement) break
          container = container.parentElement
          if (container.getAttribute('role') === 'article' ||
              (container.classList.length > 0 && container.innerText?.length > 50)) {
            break
          }
        }

        const text = container?.innerText || ''
        if (text.length < 20) continue

        const href = link.href || ''
        // Extract post ID from URL
        let fbPostId = null
        const postMatch = href.match(/\/posts\/(\d+)/) || href.match(/story_fbid=(\d+)/) || href.match(/permalink\/(\d+)/)
        if (postMatch) fbPostId = postMatch[1]
        if (!fbPostId) continue

        // Extract author
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

        // Extract content text (first 1000 chars)
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
    })

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

module.exports = scanGroupFeedHandler
