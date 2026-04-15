/**
 * Handler: Watch My Posts (standalone)
 * Monitor own published posts, auto-reply to new comments
 */

const { getPage, releaseSession } = require('../../browser/session-pool')
const { humanScroll, humanMouseMove } = require('../../browser/human')
const { saveDebugScreenshot } = require('./post-utils')
const { checkHardLimit } = require('../../lib/hard-limits')
const R = require('../../lib/randomizer')
const hermes = require('../../lib/hermes-client')

// ── Toxicity / unsafe keywords — skip replying to these comments ──
const TOXIC_KEYWORDS = [
  // Vietnamese
  'đm', 'dmm', 'địt', 'đéo', 'cc', 'cmm', 'vcl', 'vkl', 'cặc', 'buồi', 'lồn',
  'ngu', 'óc chó', 'mất dạy', 'chửi', 'bố mày', 'tao đấm',
  'lừa đảo', 'bịp', 'scam', 'lùa gà',
  // English
  'fuck', 'shit', 'asshole', 'bitch', 'scam', 'fraud', 'idiot',
]

function isToxic(text) {
  if (!text) return false
  const lower = text.toLowerCase()
  return TOXIC_KEYWORDS.some(kw => lower.includes(kw))
}

// ── Max replies per post per run — avoid burst pattern ──
const MAX_REPLIES_PER_POST = 3

async function watchMyPosts(payload, supabase) {
  const { account_id, config } = payload
  const maxPosts = config?.max_posts || 5
  const replyStyle = config?.reply_style || 'friendly'

  const { data: account } = await supabase
    .from('accounts')
    .select('*, proxies(*)')
    .eq('id', account_id)
    .single()
  if (!account) throw new Error('Account not found')

  // Check comment budget
  const commentBudget = account.daily_budget?.comment || { used: 0, max: 25 }
  const { allowed, remaining } = checkHardLimit('comment', commentBudget.used, 0)
  if (!allowed) throw new Error('SKIP_comment_budget_exceeded')

  // Get recent published posts (last 48h)
  const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString()
  const { data: posts } = await supabase
    .from('publish_history')
    .select('id, fb_post_id, post_url, target_name, target_type')
    .eq('account_id', account_id)
    .eq('status', 'success')
    .not('fb_post_id', 'is', null)
    .gte('published_at', cutoff)
    .order('published_at', { ascending: false })
    .limit(maxPosts)

  if (!posts?.length) {
    throw new Error('SKIP_no_recent_posts')
  }

  let page
  try {
    const session = await getPage(account)
    page = session.page

    let postsChecked = 0
    let repliesSent = 0

    for (const post of posts) {
      if (repliesSent >= remaining) break

      try {
        // Navigate to post (use mobile for simpler DOM)
        let postUrl = post.post_url
        if (postUrl && !postUrl.includes('m.facebook.com')) {
          postUrl = postUrl.replace('www.facebook.com', 'm.facebook.com')
        }
        if (!postUrl && post.fb_post_id) {
          postUrl = `https://m.facebook.com/${post.fb_post_id}`
        }
        if (!postUrl) continue

        console.log(`[WATCH-POSTS] Checking post: ${post.target_name || post.fb_post_id}`)
        await page.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })
        await R.sleepRange(2000, 4000)
        postsChecked++

        // Scroll to load comments
        await humanScroll(page)
        await R.sleepRange(1000, 2000)

        // Find comments that are NOT from the account owner
        const comments = await page.evaluate((ownFbUserId) => {
          const results = []
          // Expanded selectors — mobile old + desktop new
          const commentDivs = document.querySelectorAll(
            '[data-sigil="comment-body"], ' +
            'div[data-testid="UFI2Comment/body"], ' +
            '[role="article"][aria-label*="omment" i], ' +
            '[role="article"][aria-label*="ình luận" i]'
          )

          for (const div of commentDivs) {
            const text = (div.textContent || '').trim()
            if (!text || text.length < 3) continue

            const parent = div.closest('[data-sigil="comment"], [role="article"]') || div.parentElement?.parentElement

            // Skip own comments (multiple signals)
            if (parent?.querySelector('[data-sigil="edit-comment"]')) continue
            if (parent?.querySelector('[aria-label*="Edit comment" i], [aria-label*="Chỉnh sửa" i]')) continue

            // Get commenter profile link + fb user id
            const nameEl = parent?.querySelector('a[data-sigil="feed_story_ring"]')
              || parent?.querySelector('h3 a, h4 a')
              || parent?.querySelector('a[role="link"]')
              || parent?.querySelector('a')
            const name = nameEl?.textContent?.trim() || 'Someone'
            const profileHref = nameEl?.href || ''

            // Extract fb_user_id from href if possible
            let commenterFbId = null
            const idMatch = profileHref.match(/[?&](?:id|user)=(\d+)/) ||
                            profileHref.match(/\/profile\.php\?id=(\d+)/) ||
                            profileHref.match(/facebook\.com\/([^\/?]+)/)
            if (idMatch) commenterFbId = idMatch[1]

            // Skip if this is the account itself (by fb_user_id)
            if (ownFbUserId && commenterFbId && commenterFbId === String(ownFbUserId)) continue

            results.push({
              text: text.substring(0, 300),
              author: name,
              commenter_fb_id: commenterFbId,
            })
          }
          return results.slice(0, 8) // Take up to 8 candidates — will filter further
        }, account.fb_user_id)

        if (comments.length === 0) continue

        // Check which comments we already replied to (by looking at reply count in comment_logs)
        const { data: existingReplies } = await supabase
          .from('comment_logs')
          .select('comment_text')
          .eq('fb_post_id', post.fb_post_id)
          .eq('account_id', account_id)
          .eq('status', 'done')

        const repliedTexts = new Set((existingReplies || []).map(r => r.comment_text))

        // Track replies per post (avoid burst pattern)
        let repliesThisPost = 0

        // Generate and post replies for new comments
        for (const comment of comments) {
          if (repliesSent >= remaining) break
          if (repliesThisPost >= MAX_REPLIES_PER_POST) {
            console.log(`[WATCH-POSTS] Hit per-post limit (${MAX_REPLIES_PER_POST}) on ${post.fb_post_id}`)
            break
          }

          // Safety: toxicity filter — don't reply to abusive comments
          if (isToxic(comment.text)) {
            console.log(`[WATCH-POSTS] Skipping toxic comment from ${comment.author}`)
            continue
          }

          // AI reply generation via Hermes — contextual, not template
          const hermesReply = await hermes.generateReply({
            message: comment.text,
            context: `Post target: ${post.target_name || 'own post'}. Reply style: ${replyStyle}. Commenter: ${comment.author}`,
            language: 'vi',
            accountId: account_id,
            campaignId: payload.campaign_id,
          })

          let replyText = (hermesReply?.text || '').trim()
          // Fallback if Hermes fails
          if (!replyText || replyText.length < 3) {
            console.warn(`[WATCH-POSTS] Hermes reply empty for ${comment.author} — skipping this comment`)
            continue
          }
          // Clean up: remove quotes, markdown
          replyText = replyText.replace(/^["']|["']$/g, '').replace(/^```.*?\n|\n```$/g, '').trim()
          if (replyText.length > 200) replyText = replyText.substring(0, 200).replace(/\s\S*$/, '').trim()

          // Skip if duplicate of existing reply
          if (repliedTexts.has(replyText)) continue

          // Find reply button for this comment — multi-selector (mobile + desktop + Vietnamese + English)
          const replySelectors = [
            'a[data-sigil="reply"]',
            'div[role="button"][aria-label*="Reply" i]',
            'div[role="button"][aria-label*="Phản hồi" i]',
            'div[role="button"][aria-label*="Trả lời" i]',
            'span[data-sigil="m-snowlift-reply"]',
          ]
          let replyBtns = []
          for (const sel of replySelectors) {
            try {
              const found = await page.$$(sel)
              if (found.length > 0) { replyBtns = found; break }
            } catch { /* some selectors may error on certain pages */ }
          }

          if (replyBtns.length > 0) {
            try {
              // Click reply on first unreplied comment
              const replyBtn = replyBtns[0]
              await replyBtn.scrollIntoViewIfNeeded()
              await R.sleepRange(500, 1000)
              await replyBtn.click()
              await R.sleepRange(1000, 2000)

              // Find reply input
              const replyBox = await page.$([
                'textarea[name="comment_text"]',
                'div[contenteditable="true"][role="textbox"]',
              ].join(', '))

              if (replyBox) {
                await replyBox.click()
                await R.sleepRange(300, 800)

                for (const char of replyText) {
                  await page.keyboard.type(char)
                  await R.sleep(R.keyDelay())
                }

                await R.sleepRange(500, 1500)

                // Submit (Enter or submit button)
                const submitBtn = await page.$('button[type="submit"], div[data-sigil="submit_composer"]')
                if (submitBtn) {
                  await submitBtn.click()
                } else {
                  await page.keyboard.press('Enter')
                }

                await R.sleepRange(1500, 3000)

                // Log reply
                await supabase.from('comment_logs').insert({
                  owner_id: account.owner_id,
                  account_id,
                  fb_post_id: post.fb_post_id,
                  post_url: post.post_url,
                  comment_text: replyText,
                  status: 'done',
                })

                await supabase.rpc('increment_budget', {
                  p_account_id: account_id,
                  p_action_type: 'comment',
                })

                repliesSent++
                repliesThisPost++
                console.log(`[WATCH-POSTS] Replied to ${comment.author}: "${replyText}"`)
                // Positive feedback — reply was posted successfully
                hermes.sendFeedback({
                  taskType: 'reply_gen',
                  outputText: replyText,
                  score: 4,
                  accountId: account_id,
                  reason: 'reply_posted_ok',
                })
              }
            } catch (err) {
              console.warn(`[WATCH-POSTS] Reply failed: ${err.message}`)
            }
          }

          await R.sleepRange(10000, 20000) // Gap between replies
        }
      } catch (err) {
        console.warn(`[WATCH-POSTS] Failed checking post ${post.fb_post_id}: ${err.message}`)
      }

      // Gap between posts
      if (posts.indexOf(post) < posts.length - 1) {
        await R.sleepRange(15000, 30000)
      }
    }

    console.log(`[WATCH-POSTS] Done: checked ${postsChecked} posts, sent ${repliesSent} replies`)
    return {
      success: true,
      posts_checked: postsChecked,
      replies_sent: repliesSent,
    }
  } catch (err) {
    if (page) await saveDebugScreenshot(page, `watch-posts-${account_id}`)
    throw err
  } finally {
    // Keep page on FB for session reuse
    releaseSession(account_id)
  }
}

module.exports = watchMyPosts
