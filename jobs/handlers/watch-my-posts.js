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
        const comments = await page.evaluate((ownerId) => {
          const results = []
          // Look for comment containers
          const commentDivs = document.querySelectorAll('[data-sigil="comment-body"], div[data-testid="UFI2Comment/body"]')

          for (const div of commentDivs) {
            const text = div.textContent?.trim()
            if (!text || text.length < 3) continue

            // Check if it's not own comment (heuristic: own comments usually have "edit" option)
            const parent = div.closest('[data-sigil="comment"]') || div.parentElement?.parentElement
            const hasEdit = parent?.querySelector('[data-sigil="edit-comment"]')
            if (hasEdit) continue // Skip own comments

            // Get commenter name
            const nameEl = parent?.querySelector('a[data-sigil="feed_story_ring"]') || parent?.querySelector('a')
            const name = nameEl?.textContent?.trim() || 'Someone'

            results.push({
              text: text.substring(0, 200),
              author: name,
            })
          }
          return results.slice(0, 5) // Max 5 comments per post
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

        // Generate and post replies for new comments
        for (const comment of comments) {
          if (repliesSent >= remaining) break

          // AI reply generation via Hermes — contextual, not template
          const hermesReply = await hermes.generateReply({
            message: comment.text,
            context: `Post target: ${post.target_name || 'own post'}. Reply style: ${replyStyle}. Commenter: ${comment.author}`,
            language: 'vi',
            accountId: account_id,
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

          // Find reply button for this comment — on mobile FB
          const replyBtns = await page.$$('a[data-sigil="reply"], span:has-text("Phản hồi"), span:has-text("Reply")')

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
