/**
 * Scan Group Handler — Do Thám (Group Intelligence Scanner)
 * Vào feed group → scroll lấy bài mới → thu thập comments → lưu vào scout_posts/scout_comments
 *
 * KHÔNG liên quan campaign — module độc lập.
 */
const { getPage, releaseSession } = require('../../browser/session-pool')
const { delay, humanScroll, humanMouseMove, humanBrowse } = require('../../browser/human')
const { checkAccountStatus, saveDebugScreenshot } = require('./post-utils')

async function scanGroupHandler(payload, supabase) {
  const {
    account_id,
    user_id,
    scout_target_id,
    fb_group_id,
    fb_group_url,
    max_posts = 20,
    max_comments_per_post = 50,
    scan_replies = false,
    job_id,
  } = payload

  const effectiveUserId = user_id || payload.created_by || payload.owner_id
  if (!account_id) throw new Error('account_id required')
  if (!effectiveUserId) throw new Error('user_id or created_by required')
  if (!fb_group_id) throw new Error('fb_group_id required')

  const startedAt = new Date().toISOString()
  const errors = []
  let postsFound = 0
  let scanDiag = null   // chẩn đoán DOM khi không trích được bài (25/08)
  let postsNew = 0
  let postsSkipped = 0
  let commentsCollected = 0
  let groupStatus = 'done'
  let skipReason = null

  // Get account
  const { data: account } = await supabase
    .from('accounts')
    .select('*, proxies(*)')
    .eq('id', account_id)
    .single()
  if (!account) throw new Error('Account not found')

  let browserPage
  try {
    const session = await getPage(account)
    browserPage = session.page

    console.log(`[SCAN-GROUP] Starting scan for group ${fb_group_id} (target: ${scout_target_id})`)

    // Navigate to facebook first — checkpoint check
    await browserPage.goto('https://www.facebook.com/', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    })
    await delay(2000, 4000)
    const status = await checkAccountStatus(browserPage, supabase, account_id)
    if (status.blocked) {
      throw new Error(`Account blocked: ${status.detail}`)
    }

    // Navigate to group
    const groupUrl =
      fb_group_url || `https://www.facebook.com/groups/${fb_group_id}`
    console.log(`[SCAN-GROUP] Navigating to ${groupUrl}`)
    await browserPage.goto(groupUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    })
    await delay(3000, 5000)

    // Check redirect (checkpoint / kicked from group)
    const currentUrl = browserPage.url()
    if (
      currentUrl.includes('/login') ||
      currentUrl.includes('/checkpoint')
    ) {
      console.log(`[SCAN-GROUP] Redirected away from group: ${currentUrl}`)
      groupStatus = 'failed'
      skipReason = 'navigation_failed'
      errors.push({
        message: `Navigation failed — redirected to ${currentUrl}`,
        timestamp: new Date().toISOString(),
      })
    } else {
      // Simulate human browsing before scraping
      await humanBrowse(browserPage, 2)

      // Scroll and collect posts from feed
      const rawPosts = await scrollAndExtractPosts(browserPage, max_posts)
      postsFound = rawPosts.length
      try { scanDiag = await browserPage.evaluate(() => window.__scanDiag || null) } catch {}
      console.log(`[SCAN-GROUP] Found ${postsFound} posts in feed`, scanDiag ? JSON.stringify(scanDiag) : '')

      // Process each post
      for (const post of rawPosts) {
        try {
          if (!post.fb_post_id) continue

          // Dedup check
          const { data: existing } = await supabase
            .from('scout_posts')
            .select('id')
            .eq('user_id', user_id)
            .eq('post_fb_id', post.fb_post_id)
            .maybeSingle()

          if (existing) {
            postsSkipped++
            continue
          }

          // Insert new post
          const { data: insertedPost, error: insertErr } = await supabase
            .from('scout_posts')
            .insert({
              user_id,
              scout_target_id,
              fb_group_id,
              post_fb_id: post.fb_post_id,
              post_url: post.post_url || `https://www.facebook.com/groups/${fb_group_id}/posts/${post.fb_post_id}`,
              author_name: post.author_name,
              author_fb_id: post.author_fb_id,
              author_badge: post.author_badge,
              content: post.content_text,
              post_type: post.post_type || 'text',
              reaction_count: post.reactions || 0,
              comment_count: post.comments || 0,
              scanned_at: new Date().toISOString(),
              scanned_by_account_id: account_id,
            })
            .select('id')
            .single()

          if (insertErr) {
            // ON CONFLICT — race condition dedup, treat as skip
            if (insertErr.message && insertErr.message.includes('duplicate')) {
              postsSkipped++
              continue
            }
            errors.push({
              message: `Insert post ${post.fb_post_id} failed: ${insertErr.message}`,
              timestamp: new Date().toISOString(),
            })
            continue
          }

          postsNew++
          const scoutPostId = insertedPost?.id

          // Collect comments for this new post
          if (scoutPostId && max_comments_per_post > 0) {
            try {
              const commentCount = await collectCommentsForPost(
                browserPage,
                supabase,
                {
                  user_id,
                  scout_post_id: scoutPostId,
                  post_fb_id: post.fb_post_id,
                  max_comments: max_comments_per_post,
                  scan_replies,
                  post_url: post.post_url,
                }
              )
              commentsCollected += commentCount

              // Update scanned_comments_count
              await supabase
                .from('scout_posts')
                .update({ scanned_comments_count: commentCount })
                .eq('id', scoutPostId)
            } catch (commentErr) {
              errors.push({
                message: `Comments for post ${post.fb_post_id}: ${commentErr.message}`,
                timestamp: new Date().toISOString(),
              })
            }
          }

          // Random delay between posts
          await delay(5000, 15000)
        } catch (postErr) {
          errors.push({
            message: `Post ${post.fb_post_id}: ${postErr.message}`,
            stack: postErr.stack?.split('\n').slice(0, 3).join('\n'),
            timestamp: new Date().toISOString(),
          })
        }
      }
    }

    // Determine final status
    let finalStatus = 'done'
    if (postsNew === 0 && postsFound === 0 && errors.length > 0) {
      finalStatus = 'failed'
    } else if (errors.length > 0 && postsNew > 0) {
      finalStatus = 'partial'
    }

    const zeroAction = postsNew === 0 && errors.length === 0

    // Log to scout_job_logs
    await supabase.from('scout_job_logs').insert({
      user_id: effectiveUserId,
      scout_target_id,
      account_id,
      job_id,
      posts_found: postsFound,
      posts_new: postsNew,
      posts_skipped: postsSkipped,
      comments_collected: commentsCollected,
      status: finalStatus,
      error_message: errors.length > 0 ? JSON.stringify(errors) : null,
      started_at: startedAt,
      finished_at: new Date().toISOString(),
    })

    // Persist last_scan_status and last_scanned_at on scout_targets
    try {
      await supabase
        .from('scout_targets')
        .update({
          last_scan_status: finalStatus,
          last_scanned_at: new Date().toISOString()
        })
        .eq('id', scout_target_id)
    } catch {}

    const result = {
      posts_found: postsFound,
      scan_diag: scanDiag,
      posts_new: postsNew,
      posts_skipped: postsSkipped,
      comments_collected: commentsCollected,
      zero_action: zeroAction,
      errors,
      groups_visited: [
        {
          fb_group_id,
          status: groupStatus,
          ...(skipReason && { skip_reason: skipReason }),
        },
      ],
    }

    console.log(
      `[SCAN-GROUP] Done! found=${postsFound} new=${postsNew} skipped=${postsSkipped} comments=${commentsCollected} errors=${errors.length}`
    )
    return result
  } catch (err) {
    console.error(`[SCAN-GROUP] Error: ${err.message}`)
    if (browserPage) {
      await saveDebugScreenshot(browserPage, `scan-group-error-${account_id}`)
    }

    // Log failure
    try {
      await supabase.from('scout_job_logs').insert({
        user_id,
        scout_target_id,
        account_id,
        job_id,
        posts_found: postsFound,
        posts_new: postsNew,
        posts_skipped: postsSkipped,
        comments_collected: commentsCollected,
        status: 'failed',
        error_message: err.message,
        started_at: startedAt,
        finished_at: new Date().toISOString(),
      })
    } catch {}

    throw err
  } finally {
    releaseSession(account_id)
  }
}

/**
 * Scroll group feed and extract posts (pattern from scan-group-feed.js)
 */
async function scrollAndExtractPosts(page, maxPosts = 20) {
  const posts = []
  const seen = new Set()
  let noNewCount = 0
  const MAX_SCROLLS = 25
  const MAX_NO_NEW = 4
  // Wait for post links to render in DOM
  await page.waitForSelector('a[href*="/posts/"], a[href*="/permalink/"], a[href*="story_fbid"]', { timeout: 15000 }).catch(() => {})
  await delay(3000, 5000)

  for (let i = 0; i < MAX_SCROLLS; i++) {
    if (posts.length >= maxPosts) break

    const extracted = await page.evaluate(() => {
      const results = []
      const feedArea =
        document.querySelector('[role="feed"]') ||
        document.querySelector('[role="main"]') ||
        document.body

      const postLinks = feedArea.querySelectorAll(
        'a[href*="/posts/"], a[href*="/permalink/"], a[href*="story_fbid"]'
      )
      // CHẨN ĐOÁN 25/08: 17/17 phiên scan trả posts_found=0 — cần biết tắc ở
      // khâu nào (không vào được group? DOM đổi? link bài không còn dạng <a>?).
      // Số liệu đi kèm kết quả để đo được từ DB, không chỉ log ra stdout.
      window.__scanDiag = {
        url: location.href.slice(0, 120),
        feedArea: document.querySelector('[role="feed"]') ? 'feed'
          : document.querySelector('[role="main"]') ? 'main' : 'body',
        links: postLinks.length,
        articles: feedArea.querySelectorAll('[role="article"]').length,
        anyAnchor: feedArea.querySelectorAll('a[href]').length,
        bodyLen: (document.body.innerText || '').length,
        joinBtn: !!Array.from(document.querySelectorAll('div[role="button"],a')).find(b => /tham gia nhóm|join group/i.test(b.textContent || '')),
      }

      for (const link of postLinks) {
        const href = link.href || ''

        // BUG 25/08 — guard cũ loại THẲNG mọi href chứa comment_id, nhưng link
        // dấu thời gian của Facebook trong nhóm có dạng
        //   /groups/<gid>/posts/<pid>/?comment_id=<cid>
        // tức là link BÀI hợp lệ chỉ kèm neo tới bình luận. Đo thật: 6/6 link bị
        // loại vì lý do này → posts_found=0 suốt 17 phiên, scout chết hẳn.
        //
        // Cách đúng: lấy id bài từ ĐƯỜNG DẪN (bỏ query). Có id bài thì đó là bài
        // — dùng được bất kể query có comment_id. Không moi được id bài thì mới
        // bỏ (link bình luận thuần, link hồ sơ, link nhóm...).
        const pathOnly = href.split('?')[0]
        let fbPostId = null
        const postMatch =
          pathOnly.match(/\/posts\/(\d+)/) ||
          pathOnly.match(/permalink\/(\d+)/) ||
          href.match(/story_fbid=(\d+)/)
        if (postMatch) fbPostId = postMatch[1]
        if (!fbPostId) continue

        // Walk up to find top-level post container (article not inside another article)
        let container = link
        for (let j = 0; j < 10; j++) {
          if (!container.parentElement) break
          container = container.parentElement
          if (
            container.getAttribute('role') === 'article' &&
            !container.parentElement.closest('[role="article"]')
          ) {
            break
          }
        }

        const text = container?.innerText || ''
        if (text.length < 20) continue

        function norm(s) {
          return (s || '').replace(/[\u00a0\u200b]/g, ' ').replace(/\s+/g, ' ').trim()
        }

        const lines = text.split('\n').map(l => norm(l)).filter(Boolean)
        let authorName = null
        let authorFbId = null
        let authorBadge = null

        const badgePatterns = /^(?:Người đóng góp đang lên|Người đóng góp nhiều nhất|Tác giả|Top fan|Top Fan|Quản trị viên|Người kiểm duyệt|Follow|Theo dõi)$/i
        const actionPatterns = /^(?:\d+\s*(?:ngày|giờ|phút|tuần|tháng|năm|d|h|m|w)|thích|bình luận|chia sẻ|like|comment|share|xem thêm|view more|\d+(?:[.,]\d+)?[KkMm]?)$/i

        // 1. Try finding author from DOM link inside container
        const authorLink = container.querySelector(
          'h2 a, h3 a, h4 a, strong > a, a[href*="profile.php"], a[href*="/user/"], a[role="link"] span'
        )
        if (authorLink) {
          const rawName = norm(authorLink.textContent)
          if (rawName && !badgePatterns.test(rawName) && !actionPatterns.test(rawName) && rawName.length < 60) {
            authorName = rawName
          }
          const authorHref = authorLink.closest('a')?.href || authorLink.href || ''
          const m = authorHref.match(/facebook\.com\/(?:profile\.php\?id=)?(\d+)/) || authorHref.match(/facebook\.com\/([^/?]+)/)
          if (m) authorFbId = m[1]
        }

        // Fallback for authorName to lines[0] if still null
        if (!authorName && lines.length > 0) {
          const l0 = lines[0]
          if (!badgePatterns.test(l0) && !actionPatterns.test(l0) && l0.length >= 2 && l0.length < 60) {
            authorName = l0
          }
        }

        // Find authorBadge in early header lines
        for (let k = 0; k < Math.min(lines.length, 5); k++) {
          if (badgePatterns.test(lines[k])) {
            authorBadge = lines[k]
            break
          }
        }

        // Engagement
        let reactions = 0,
          comments = 0,
          shares = 0
        const engText = text.match(
          /(\d+(?:[.,]\d+)?[KkMm]?)\s*(?:reactions?|lượt thích|cảm xúc)/i
        )
        const comText = text.match(
          /(\d+(?:[.,]\d+)?[KkMm]?)\s*(?:comments?|bình luận)/i
        )
        const shareText = text.match(
          /(\d+(?:[.,]\d+)?[KkMm]?)\s*(?:shares?|chia sẻ|lượt chia sẻ)/i
        )

        function parseCount(str) {
          if (!str) return 0
          str = str.replace(/,/g, '.')
          if (/[kK]/.test(str))
            return Math.round(parseFloat(str) * 1000)
          if (/[mM]/.test(str))
            return Math.round(parseFloat(str) * 1000000)
          return parseInt(str) || 0
        }

        if (engText) reactions = parseCount(engText[1])
        if (comText) comments = parseCount(comText[1])
        if (shareText) shares = parseCount(shareText[1])

        // Content — Extract complete post message body
        const contentLines = []
        for (let k = 0; k < lines.length; k++) {
          const l = lines[k]
          if (authorName && norm(l) === norm(authorName)) continue
          if (authorBadge && norm(l) === norm(authorBadge)) continue
          if (badgePatterns.test(l)) continue
          if (actionPatterns.test(l)) continue
          if (/^(?:Tất cả cảm xúc:|Xem tất cả|Xem thêm bình luận|\d+\s*bình luận|Viết bình luận...)/i.test(l)) break

          contentLines.push(l)
        }

        const contentText = Array.from(new Set(contentLines)).join('\n').substring(0, 3000).trim()

        // Detect post type
        let postType = 'text'
        if (container.querySelector('video')) postType = 'video'
        else if (
          container.querySelector('img[src*="scontent"]') &&
          !container
            .querySelector('img[src*="scontent"]')
            ?.closest('[role="link"]')
        )
          postType = 'photo'
        else if (
          container.querySelector('a[href*="l.facebook.com"]')
        )
          postType = 'link'

        results.push({
          fb_post_id: fbPostId,
          author_name: authorName,
          author_fb_id: authorFbId,
          author_badge: authorBadge,
          content_text: contentText,
          post_url: href.split('?')[0],
          reactions,
          comments,
          shares,
          post_type: postType,
        })
      }

      return results
    })

    // Dedup in-memory
    let hasNew = false
    for (const post of extracted) {
      if (!seen.has(post.fb_post_id) && posts.length < maxPosts) {
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

/**
 * Collect comments for a specific post
 * Navigates to the post page and extracts comments from DOM
 */
async function collectCommentsForPost(page, supabase, opts) {
  const {
    user_id,
    scout_post_id,
    post_fb_id,
    max_comments,
    scan_replies,
    post_url,
  } = opts

  let collected = 0

  // Navigate to the post URL to see all comments
  if (post_url) {
    try {
      await page.goto(post_url, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      })
      await delay(2000, 4000)
    } catch (navErr) {
      console.log(
        `[SCAN-GROUP] Could not navigate to post ${post_fb_id}: ${navErr.message}`
      )
      return 0
    }
  }

  // Try expanding "View more comments" / "Xem thêm bình luận"
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const expanded = await page.evaluate(() => {
        const btns = [
          ...document.querySelectorAll(
            'span[role="button"], div[role="button"]'
          ),
        ]
        const viewMore = btns.find((b) => {
          const t = (b.textContent || '').toLowerCase()
          return (
            t.includes('view more comment') ||
            t.includes('xem thêm bình luận') ||
            t.includes('view all') ||
            t.includes('xem tất cả')
          )
        })
        if (viewMore) {
          viewMore.click()
          return true
        }
        return false
      })
      if (expanded) {
        await delay(2000, 4000)
      } else {
        break
      }
    } catch {
      break
    }
  }

  // Scroll to load more comments
  for (let s = 0; s < 3; s++) {
    await humanScroll(page)
    await delay(1000, 2000)
  }

  // Extract comments from DOM
  const comments = await page.evaluate(
    ({ scanReplies }) => {
      const results = []

      // Find comment containers — Facebook uses nested article roles or specific data attributes
      const commentElements = document.querySelectorAll(
        'div[aria-label*="Comment"], div[aria-label*="Bình luận"], ul[role="list"] > li'
      )

      // Fallback: find by walking article elements that look like comments (shorter, nested)
      const fallbackComments = []
      if (commentElements.length === 0) {
        const articles = document.querySelectorAll('[role="article"]')
        for (const art of articles) {
          const text = art.innerText || ''
          // Comments are usually shorter than posts and nested
          if (text.length > 5 && text.length < 2000) {
            const depth = art.closest('[role="article"] [role="article"]')
            if (depth) {
              fallbackComments.push(art)
            }
          }
        }
      }

      const elements =
        commentElements.length > 0
          ? commentElements
          : fallbackComments

      for (const el of elements) {
        const text = el.innerText || ''
        if (text.length < 3) continue

        // Determine if reply
        const isReply = !scanReplies
          ? false
          : !!el.closest(
              '[role="article"] [role="article"] [role="article"]'
            )

        // Skip replies if not scanning them
        if (
          !scanReplies &&
          el.closest(
            '[role="article"] [role="article"] [role="article"]'
          )
        ) {
          continue
        }

        // 1. Extract Author Name & Badge
        let authorName = null
        let authorFbId = null
        let authorBadge = null
        const badgePatterns = /^(?:Người đóng góp đang lên|Người đóng góp nhiều nhất|Tác giả|Top fan|Top Fan|Quản trị viên|Người kiểm duyệt|Follow|Theo dõi)$/i

        const authorEl = el.querySelector(
          'a[role="link"] span, a[role="link"] strong, h2 a, h3 a, h4 a, strong > span, a[href*="profile.php"]'
        )
        function norm(s) {
          return (s || '').replace(/[\u00a0\u200b]/g, ' ').replace(/\s+/g, ' ').trim()
        }

        if (authorEl) {
          const rawName = norm(authorEl.textContent)
          if (rawName && badgePatterns.test(rawName)) {
            authorBadge = rawName
          } else if (rawName) {
            authorName = rawName
          }
          const authorHref = authorEl.closest('a')?.href || ''
          const m = authorHref.match(/facebook\.com\/(?:profile\.php\?id=)?(\d+)/) || authorHref.match(/facebook\.com\/([^/?]+)/)
          if (m) authorFbId = m[1]
        }

        if (!authorName && lines.length > 0) {
          for (const l of lines) {
            const nl = norm(l)
            if (badgePatterns.test(nl)) {
              if (!authorBadge) authorBadge = nl
              continue
            }
            if (/^(?:\d+\s*(?:ngày|giờ|phút|tuần|tháng|năm|d|h|m|w)|thích|like|trả lời|reply|chia sẻ|share)/i.test(nl)) continue
            authorName = nl
            break
          }
        }

        // 2. Extract Comment Body Text cleanly
        let content = ''
        const textLines = text.split('\n').map(x => norm(x)).filter(Boolean)
        const cleanLines = textLines.filter(l => {
          if (!l) return false
          if (authorName && norm(l) === norm(authorName)) return false
          if (authorBadge && norm(l) === norm(authorBadge)) return false
          if (badgePatterns.test(l)) return false
          if (/^(?:\d+\s*(?:ngày|giờ|phút|tuần|tháng|năm|d|h|m|w)|thích|like|trả lời|reply|chia sẻ|share|viết bình luận...|xem tất cả|view all|\d+)$/i.test(l)) return false
          return true
        })

        if (cleanLines.length > 0) {
          content = Array.from(new Set(cleanLines)).join('\n').trim()
        }

        // If no text lines, check for Sticker/Image/Video
        if (!content) {
          const hasImg = el.querySelector('img[src*="sticker"], img[src*="fbcdn"], svg[aria-label*="sticker"], video')
          if (hasImg) {
            content = '[Hình ảnh / Sticker / GIF]'
          }
        }

        // If STILL empty or equals authorName, SKIP this element (do NOT insert!)
        if (!content || norm(content) === norm(authorName)) {
          continue
        }

        // Try to extract a comment ID from any link
        let commentFbId = null
        const timeLink = el.querySelector('a[href*="comment_id="]')
        if (timeLink) {
          const m = timeLink.href.match(/comment_id=(\d+)/)
          if (m) commentFbId = m[1]
        }
        // Fallback: generate from content hash
        if (!commentFbId) {
          commentFbId = `gen_${hashCode(
            (authorName || '') + content.substring(0, 50)
          )}`
        }

        // Reaction count
        let reactionCount = 0
        const reactEl = el.querySelector(
          '[aria-label*="reaction"], [aria-label*="thích"]'
        )
        if (reactEl) {
          const m = (reactEl.getAttribute('aria-label') || '').match(
            /(\d+)/
          )
          if (m) reactionCount = parseInt(m[1]) || 0
        }

        results.push({
          comment_fb_id: commentFbId,
          author_name: authorName,
          author_fb_id: authorFbId,
          content,
          reaction_count: reactionCount,
          is_reply: isReply,
          parent_comment_fb_id: null, // hard to extract from DOM reliably
        })
      }

      return results

      function hashCode(str) {
        let hash = 0
        for (let i = 0; i < str.length; i++) {
          const chr = str.charCodeAt(i)
          hash = (hash << 5) - hash + chr
          hash |= 0
        }
        return Math.abs(hash).toString(36)
      }
    },
    { scanReplies: scan_replies }
  )

  console.log(
    `[SCAN-GROUP] Extracted ${comments.length} comments for post ${post_fb_id}`
  )

  // Insert comments (dedup via ON CONFLICT DO NOTHING)
  for (const comment of comments) {
    if (collected >= max_comments) break
    try {
      const { error } = await supabase
        .from('scout_comments')
        .upsert(
          {
            user_id,
            scout_post_id,
            post_fb_id,
            comment_fb_id: comment.comment_fb_id,
            author_name: comment.author_name,
            author_fb_id: comment.author_fb_id,
            content: comment.content,
            reaction_count: comment.reaction_count || 0,
            is_reply: comment.is_reply || false,
            parent_comment_fb_id: comment.parent_comment_fb_id,
            scanned_at: new Date().toISOString(),
          },
          { onConflict: 'user_id,comment_fb_id', ignoreDuplicates: true }
        )

      if (!error) collected++
    } catch (e) {
      console.log(
        `[SCAN-GROUP] Comment insert error: ${e.message}`
      )
    }
  }

  return collected
}

module.exports = scanGroupHandler
