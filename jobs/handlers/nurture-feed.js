/**
 * Nurture Feed — Smart nick nurturing via personal news feed
 *
 * Unlike campaign-nurture (which targets groups), this handler:
 * - Browses the personal news feed
 * - Reacts to FRIENDS' posts only (not pages, ads, groups)
 * - Selectively comments on "easy" posts (food, travel, birthday)
 * - Optionally views stories
 * - Simulates natural human behavior
 */

const { getPage, releaseSession } = require('../../browser/session-pool')
const { humanScroll, humanMouseMove } = require('../../browser/human')
const R = require('../../lib/randomizer')
const { SessionTracker, applyAgeFactor, checkHardLimit } = require('../../lib/hard-limits')
const hermes = require('../../lib/hermes-client')
const { resolvePostLink } = require('../../lib/post-link')
const feedDom = require('../../browser/feed-dom')

// ── Comment Templates for "Easy" Post Categories ──
const COMMENT_TEMPLATES = {
  travel: [
    'Đẹp quá!', 'Ở đâu đây bạn?', 'View đẹp thật', 'Đi chơi vui hen!',
    'Ghé đây lần nào chưa', 'Xinh quá!', 'Thích ghê', 'Mê quá',
  ],
  food: [
    'Nhìn ngon quá!', 'Quán nào vậy?', 'Thèm ghê', 'Ngon dữ',
    'Trông hấp dẫn quá', 'Ăn ở đâu vậy?', 'Nhìn là thèm rồi',
  ],
  celebration: [
    'Chúc mừng!', 'Chúc mừng bạn nha!', 'Happy birthday!', 'Chúc mừng nha',
    'Quá tuyệt vời!', 'Congrats!', 'Chúc mừng sinh nhật!',
  ],
  photo: [
    'Nice!', 'Đẹp quá!', 'Xinh quá!', 'Cool!',
    'Nhìn xịn ghê', 'Ảnh đẹp quá',
  ],
}

// ── Post Classification Keywords ──
const EASY_CATEGORIES = {
  travel: {
    keywords: [
      'check in', 'checkin', 'du lịch', 'travel', 'trip', 'biển', 'núi',
      'sapa', 'đà lạt', 'hội an', 'phú quốc', 'đà nẵng', 'nha trang',
      'vũng tàu', 'hạ long', 'phan thiết', 'cần thơ', 'huế',
      'resort', 'hotel', 'beach', 'mountain', 'island',
    ],
  },
  food: {
    keywords: [
      'ngon', 'ăn', 'quán', 'nhà hàng', 'food', 'cook', 'nấu',
      'bún', 'phở', 'cơm', 'bánh', 'trà', 'coffee', 'cafe', 'cà phê',
      'hải sản', 'lẩu', 'nướng', 'buffet', 'món', 'thực đơn',
    ],
  },
  celebration: {
    keywords: [
      'sinh nhật', 'happy birthday', 'chúc mừng', 'anniversary', 'kỷ niệm',
      'tốt nghiệp', 'graduation', 'thăng chức', 'khai trương',
      'congrats', 'celebrate', 'milestone',
    ],
  },
}

// Keywords to NEVER comment on
const SKIP_KEYWORDS = [
  'chính trị', 'politics', 'chết', 'die', 'tai nạn', 'accident',
  'bệnh nặng', 'cancer', 'qua đời', 'rip', 'passed away', 'mất',
  'chia tay', 'breakup', 'ly hôn', 'divorce', 'buồn quá', 'thất vọng',
  'tự tử', 'bạo lực', 'giết', 'chiến tranh', 'biểu tình',
]

/**
 * Classify a post from the news feed
 * Returns: 'friend' | 'page' | 'ad' | 'group' | 'suggestion' | 'unknown'
 */
function classifyPost(postData) {
  const { headerText, hasAdSignal, hasGroupLink, hasPageSignal, hasSuggestion } = postData

  if (hasAdSignal) return 'ad'
  if (hasSuggestion) return 'suggestion'
  if (hasGroupLink) return 'group'
  if (hasPageSignal) return 'page'

  // Default to friend if no signals detected
  return 'friend'
}

/**
 * Determine if a friend's post is "easy" to comment on
 * Returns: { category, templates } or null if not easy
 */
function classifyEasyPost(postText) {
  if (!postText || postText.length < 3) return null

  const lower = postText.toLowerCase()

  // Check skip keywords first
  for (const kw of SKIP_KEYWORDS) {
    if (lower.includes(kw)) return null
  }

  // Check easy categories
  for (const [category, config] of Object.entries(EASY_CATEGORIES)) {
    for (const kw of config.keywords) {
      if (lower.includes(kw)) {
        return { category, templates: COMMENT_TEMPLATES[category] }
      }
    }
  }

  // Short post with images = likely a photo post
  if (postText.length < 100) {
    return { category: 'photo', templates: COMMENT_TEMPLATES.photo }
  }

  return null
}

/**
 * Pick a random comment from templates
 */
function pickComment(templates) {
  return templates[Math.floor(Math.random() * templates.length)]
}

// ── Main Handler ──
async function nurtureFeed(payload, supabase) {
  const {
    account_id, nurture_profile_id, persona,
    remain_reacts = 4, remain_comments = 1, remain_stories = 2,
    age_days = 30,
  } = payload

  const { data: account } = await supabase
    .from('accounts')
    .select('*, proxies(*)')
    .eq('id', account_id)
    .single()
  if (!account) throw new Error('Account not found')

  const session = new SessionTracker()
  const startTime = Date.now()
  const results = {
    success: false, reacts: 0, comments: 0, stories: 0,
    posts_seen: 0, friend_posts: 0, skipped: 0, errors: [],
  }
  const activityLogs = []

  const ownerId = payload.owner_id || payload.created_by || account.owner_id

  // Tham số `post` (tuỳ chọn) để mỗi dòng nhật ký dẫn được về bài gốc.
  // Trước đây hàm này KHÔNG nhận target_url nên mọi lượt like ghi ra đều không
  // có link — đo thực tế 45/45 dòng react trống link, báo cáo không kiểm chứng
  // được. Xem lib/post-link.js về thứ tự ưu tiên và ý nghĩa `link_accuracy`.
  const log = (action_type, target_type, target_name, result_status, details = {}, post = null) => {
    const link = post
      ? resolvePostLink({ postUrl: post.postUrl, fbPostId: post.fbPostId, authorFbId: post.authorFbId })
      : { url: null, accuracy: 'none' }
    activityLogs.push({
      account_id,
      owner_id: ownerId,
      action_type,
      target_type,
      target_name,
      target_id: post?.fbPostId || null,
      target_url: link.url,
      result_status,
      details: { ...details, nurture_profile_id, ...(post ? { link_accuracy: link.accuracy } : {}) },
      source: 'nurture',
    })
  }

  let page
  try {
    const sess = await getPage(account)
    page = sess.page

    log('session_start', 'feed', null, 'success', { persona, age_days })

    // ── Phase 1: Navigate to News Feed ──
    console.log(`[NURTURE] ${account.username}: Opening news feed...`)
    await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 30000 })
    await R.sleepRange(2000, 4000)

    // Check for checkpoint
    const isCheckpoint = await page.evaluate(() => {
      return document.body.innerText.includes('checkpoint') ||
        document.body.innerText.includes('We need to verify') ||
        document.body.innerText.includes('Xác minh')
    }).catch(() => false)

    if (isCheckpoint) {
      log('error', 'feed', null, 'failed', { error: 'checkpoint_detected' })
      throw new Error('CHECKPOINT detected')
    }

    // ── Phase 2+3: Cuộn feed & gom bài ──
    //
    // BUG CŨ (đo thật 25/08: posts_seen=2 suốt 9 phiên liên tiếp, reacts=0):
    // khối này tự quét bằng document.querySelectorAll('[role="article"]').
    // Facebook dùng CHUNG role="article" cho bài viết LẪN bình luận, và trên
    // newsfeed hiện tại phần lớn node role="article" là comment — nên hầu như
    // không bắt được bài nào. browser/feed-dom.js đã giải đúng bài toán này
    // (bài = div[aria-posinset]) và feed_scroll dùng nó quét được 27-32 bài
    // mỗi phiên. Dùng chung một nguồn sự thật thay vì mỗi handler tự quét.
    //
    // Thẻ data-nurture-* phải gán NGAY khi bài vừa hiện (onBatch): cuộn tiếp
    // thì React unmount node cũ, gán sau sẽ mất phần lớn bài.
    const posts = []
    await feedDom.scrollAndCollect(page, {
      scrolls: R.randInt(5, 8),
      dwellMs: [2500, 5000],
      shouldStop: () => posts.length >= 30,
      onBatch: async (fresh) => {
        const marks = []
        for (const p of fresh) {
          if (posts.length >= 30) break
          const index = posts.length
          marks.push({ pos: p.posinset, index })
          posts.push({
            index,
            posinset: p.posinset,
            postUrl: p.link || null,
            fbPostId: p.fbPostId || null,
            authorFbId: p.authorFbId || null,
            text: (p.text || '').substring(0, 300),
            headerText: (p.author || '').substring(0, 200),
            hasAdSignal: !!p.isAd,
            hasGroupLink: /\/groups\//.test(p.link || '') || /\/groups\//.test(p.authorHref || ''),
            hasPageSignal: p.authorType === 'page',
            hasSuggestion: !!p.isSuggested,
            hasLikeBtn: !!p.canLike,
            hasCommentBtn: !!p.canComment,
            hasImages: false,
          })
        }
        if (!marks.length) return
        await page.evaluate((ms) => {
          for (const m of ms) {
            if (!m.pos) continue
            const n = document.querySelector('div[aria-posinset="' + m.pos + '"]')
            if (!n) continue
            const btns = Array.from(n.querySelectorAll('[role="button"]'))
            const likeBtn = btns.find(b => /^(Like|Thích)$/i.test(b.getAttribute('aria-label') || '')
              && b.getAttribute('aria-pressed') !== 'true')
            const cmtBtn = btns.find(b => /^(Comment|Bình luận)$/i.test(b.getAttribute('aria-label') || ''))
            if (likeBtn) likeBtn.setAttribute('data-nurture-like', String(m.index))
            if (cmtBtn) cmtBtn.setAttribute('data-nurture-comment', String(m.index))
          }
        }, marks).catch(() => {})
      },
    })
    log('feed_browse', 'feed', null, 'success', { posts: posts.length })

    results.posts_seen = posts.length
    console.log(`[NURTURE] ${account.username}: Found ${posts.length} posts in feed`)

    // ── Phase 4: Filter to Friend Posts Only ──
    const friendPosts = posts.filter(p => {
      const type = classifyPost(p)
      return type === 'friend' && p.hasLikeBtn
    })
    results.friend_posts = friendPosts.length
    console.log(`[NURTURE] ${account.username}: ${friendPosts.length} friend posts identified`)

    // ── Phase 5: React to Friend Posts ──
    const maxReacts = Math.min(
      remain_reacts,
      applyAgeFactor(5, age_days), // session max 5, adjusted by age (young = 2-3)
      friendPosts.length
    )

    // Shuffle friend posts for randomness
    const shuffled = [...friendPosts].sort(() => Math.random() - 0.5)

    for (let i = 0; i < shuffled.length && results.reacts < maxReacts; i++) {
      const post = shuffled[i]

      try {
        // Thẻ đánh dấu có thể biến mất khi React re-render giữa lúc quét và
        // lúc bấm. Gán lại theo posinset + xác minh danh tính (đầu nội dung)
        // trước khi bỏ cuộc — nếu không, mỗi lần re-render là mất trắng 1 like.
        let btn = await page.$(`[data-nurture-like="${post.index}"]`)
        if (!btn && post.posinset) {
          const remarked = await page.evaluate(({ pos, index, head }) => {
            const n = document.querySelector('div[aria-posinset="' + pos + '"]')
            if (!n) return false
            const txt = (n.textContent || '').replace(/\s+/g, ' ')
            if (head && head.length >= 20 && !txt.includes(head)) return false  // vị trí đã là bài khác
            const b = Array.from(n.querySelectorAll('[role="button"]')).find(x =>
              /^(Like|Thích)$/i.test(x.getAttribute('aria-label') || '') && x.getAttribute('aria-pressed') !== 'true')
            if (!b) return false
            b.setAttribute('data-nurture-like', String(index))
            return true
          }, { pos: post.posinset, index: post.index, head: (post.text || '').replace(/\s+/g, ' ').slice(0, 40) }).catch(() => false)
          if (remarked) btn = await page.$(`[data-nurture-like="${post.index}"]`)
        }
        if (!btn) continue

        await btn.scrollIntoViewIfNeeded()
        // Đọc bài trước khi like — người thật đọc 1.5-3.5 giây
        await R.sleepRange(1500, 3500)
        await humanMouseMove(page)

        // Click via JS dispatch (React-compatible)
        await page.evaluate(idx => {
          const el = document.querySelector(`[data-nurture-like="${idx}"]`)
          if (!el) return
          el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        }, post.index)

        results.reacts++
        session.increment('nurture_react')
        log('react', 'friend_post', null, 'success', {
          post_text: post.text?.substring(0, 100),
        }, post)
        console.log(`[NURTURE] ${account.username}: Liked friend post (${results.reacts}/${maxReacts})`)

        // Sau khi like — scroll thêm, nghỉ 3-7 giây trước bài tiếp
        await humanScroll(page)
        await R.sleepRange(3000, 7000)

        // ── Phase 5b: Maybe Comment (20% chance on easy posts) ──
        if (
          results.comments < remain_comments &&
          session.get('nurture_comment') < 2 &&
          Math.random() < 0.2 &&
          post.hasCommentBtn
        ) {
          // Quick heuristic first — skip political/tragic/sensitive posts
          const easyPost = classifyEasyPost(post.text)
          if (easyPost) {
            try {
              // Hermes decides the actual action + text (not template)
              // Try once; if JSON parse failed, retry with strict format hint
              let decision = await hermes.decideAction({
                post: { text: post.text, author: post.headerText || 'friend' },
                campaignTopic: 'personal nurture — friendly engagement',
                accountId: account_id,
              })

              // Retry with strict JSON-only instruction if parse failed
              if (!decision?.data) {
                console.log(`[NURTURE] action_decision returned no JSON — retrying with strict format`)
                decision = await hermes.callHermesJson('action_decision',
                  `Post: "${(post.text || '').substring(0, 300)}"\nAuthor: ${post.headerText || 'friend'}\n\n` +
                  `Respond in JSON only, no prose: {"action": "like"|"comment"|"share"|"skip", "reason": "short", "comment_text": "only if action=comment"}`,
                  { accountId: account_id, maxTokens: 150, temperature: 0.1 }
                )
              }

              const action = decision?.data?.action || 'like'
              let commentText = null

              // Handle share action — Hermes rarely suggests this, but respect it if it does
              if (action === 'share') {
                console.log(`[NURTURE] Hermes suggested SHARE for post ${post.index} — skipping (share flow not implemented, safer to skip than force another action)`)
                continue
              }

              if (action === 'skip') {
                continue // Hermes explicitly said skip
              }

              if (action === 'comment' && decision.data?.comment_text) {
                commentText = decision.data.comment_text.trim().replace(/^["']|["']$/g, '')
              }

              // If Hermes said like (not comment) or didn't produce text → fall back to template
              if (!commentText && easyPost.templates) {
                commentText = pickComment(easyPost.templates)
              }

              if (!commentText || commentText.length < 2) {
                continue
              }

              // Click comment button
              const commentBtn = await page.$(`[data-nurture-comment="${post.index}"]`)
              if (commentBtn) {
                await commentBtn.scrollIntoViewIfNeeded()
                // Suy nghĩ trước khi quyết định comment — 1.5-3s
                await R.sleepRange(1500, 3000)
                await commentBtn.click()
                // Đợi comment box mở — 1-2.5s
                await R.sleepRange(1000, 2500)

                // Find comment input
                const commentInput = await page.$('[contenteditable="true"][role="textbox"]')
                if (commentInput) {
                  await commentInput.click()
                  await R.sleepRange(500, 1500)

                  // Type naturally — người thật gõ 50-120ms/ký tự
                  for (const char of commentText) {
                    await page.keyboard.type(char, { delay: R.randInt(50, 120) })
                  }
                  // Đọc lại trước khi gửi — 1-3s
                  await R.sleepRange(1000, 3000)

                  // Submit with Enter
                  await page.keyboard.press('Enter')
                  // Đợi sau khi comment — nghỉ 4-8s
                  await R.sleepRange(4000, 8000)

                  results.comments++
                  session.increment('nurture_comment')
                  log('comment', 'friend_post', null, 'success', {
                    comment_text: commentText,
                    category: easyPost.category,
                    source: decision?.data?.comment_text ? 'hermes' : 'template',
                    post_text: post.text?.substring(0, 100),
                  }, post)
                  console.log(`[NURTURE] ${account.username}: Commented "${commentText}" on ${easyPost.category} post (${decision?.data?.comment_text ? 'hermes' : 'template'})`)
                  // Feedback
                  hermes.sendFeedback({
                    taskType: 'action_decision',
                    outputText: commentText,
                    score: decision?.data?.comment_text ? 4 : 3,
                    accountId: account_id,
                    reason: 'feed_comment_posted',
                  })
                }
              }
            } catch (err) {
              log('comment', 'friend_post', null, 'failed', { error: err.message }, post)
              results.errors.push(`comment: ${err.message}`)
            }
          }
        }

      } catch (err) {
        results.errors.push(`react: ${err.message}`)
        results.skipped++
      }
    }

    // ── Phase 6: View Stories (30% chance) ──
    if (Math.random() < 0.3 && remain_stories > 0) {
      try {
        console.log(`[NURTURE] ${account.username}: Viewing stories...`)

        // Scroll to top first
        await page.evaluate(() => window.scrollTo(0, 0))
        await R.sleepRange(1000, 2000)

        // Find story items (skip first = "Create story")
        const storyCount = await page.evaluate(() => {
          const tray = document.querySelector('[aria-label="Stories"], [aria-label="Tin"]')
          if (!tray) return 0
          const items = tray.querySelectorAll('[role="button"], [role="link"]')
          return items.length
        })

        if (storyCount > 1) {
          // Click second story (first is "Create story")
          const clicked = await page.evaluate(() => {
            const tray = document.querySelector('[aria-label="Stories"], [aria-label="Tin"]')
            if (!tray) return false
            const items = tray.querySelectorAll('[role="button"], [role="link"]')
            if (items.length > 1) {
              items[1].click()
              return true
            }
            return false
          })

          if (clicked) {
            const viewCount = Math.min(R.randInt(2, 5), remain_stories)
            for (let s = 0; s < viewCount; s++) {
              await R.sleepRange(1500, 3500) // Watch story (optimized)

              // Try to advance to next story
              const advanced = await page.evaluate(() => {
                const nextBtn = document.querySelector('[aria-label="Next"], [aria-label="Tiếp"]')
                if (nextBtn) { nextBtn.click(); return true }
                return false
              }).catch(() => false)

              if (!advanced) break

              results.stories++
              session.increment('nurture_story')
              log('story_view', 'story', null, 'success')
            }

            // Close stories
            await page.keyboard.press('Escape')
            await R.sleepRange(1000, 2000)
            console.log(`[NURTURE] ${account.username}: Watched ${results.stories} stories`)
          }
        }
      } catch (err) {
        // Stories are volatile — silently fail
        results.errors.push(`stories: ${err.message}`)
      }
    }

    // ── Phase 7: Session Complete ──
    results.success = true
    results.duration = Math.round((Date.now() - startTime) / 1000)
    log('session_end', 'feed', null, 'success', {
      reacts: results.reacts,
      comments: results.comments,
      stories: results.stories,
      duration: results.duration,
    })

    console.log(`[NURTURE] ${account.username}: Session done — ${results.reacts} reacts, ${results.comments} comments, ${results.stories} stories (${results.duration}s)`)

    // ── Update nurture_profiles counters ──
    if (nurture_profile_id) {
      const updates = {
        updated_at: new Date().toISOString(),
      }

      // Atomic increments via RPC
      if (results.reacts > 0) {
        await supabase.rpc('increment_nurture_counter', {
          p_profile_id: nurture_profile_id, p_field: 'today_reacts', p_amount: results.reacts,
        }).then(() => {}, () => {})
        await supabase.rpc('increment_nurture_counter', {
          p_profile_id: nurture_profile_id, p_field: 'total_reacts', p_amount: results.reacts,
        }).then(() => {}, () => {})
      }
      if (results.comments > 0) {
        await supabase.rpc('increment_nurture_counter', {
          p_profile_id: nurture_profile_id, p_field: 'today_comments', p_amount: results.comments,
        }).then(() => {}, () => {})
        await supabase.rpc('increment_nurture_counter', {
          p_profile_id: nurture_profile_id, p_field: 'total_comments', p_amount: results.comments,
        }).then(() => {}, () => {})
      }
      if (results.stories > 0) {
        await supabase.rpc('increment_nurture_counter', {
          p_profile_id: nurture_profile_id, p_field: 'today_stories', p_amount: results.stories,
        }).then(() => {}, () => {})
      }

      // Increment sessions + total
      await supabase.rpc('increment_nurture_counter', {
        p_profile_id: nurture_profile_id, p_field: 'today_sessions', p_amount: 1,
      }).then(() => {}, () => {})
      await supabase.rpc('increment_nurture_counter', {
        p_profile_id: nurture_profile_id, p_field: 'total_sessions', p_amount: 1,
      }).then(() => {}, () => {})

      // Update health score
      try {
        const healthDelta = results.success ? 5 : -5
        const { data: profData } = await supabase
          .from('nurture_profiles').select('health_score').eq('id', nurture_profile_id).single()
        const currentHealth = profData?.health_score ?? 100
        await supabase.from('nurture_profiles').update({
          health_score: Math.max(0, Math.min(100, currentHealth + healthDelta)),
          ...updates,
        }).eq('id', nurture_profile_id)
      } catch {}
    }

    // ── Flush activity logs ──
    if (activityLogs.length > 0) {
      try {
        const { error: logErr } = await supabase.from('campaign_activity_log').insert(activityLogs)
        if (logErr) console.error(`[NURTURE] Failed to flush activity logs:`, logErr.message)
      } catch (logEx) {
        console.error(`[NURTURE] Activity log exception:`, logEx.message)
      }
    }

    return results

  } catch (err) {
    log('error', 'feed', null, 'failed', { error: err.message })

    // Flush whatever logs we have
    if (activityLogs.length > 0) {
      try {
        await supabase.from('campaign_activity_log').insert(activityLogs)
      } catch {}
    }

    // Health penalty on error
    if (nurture_profile_id) {
      try {
      const penalty = err.message.includes('CHECKPOINT') ? -30 : -10
      const { data: prof } = await supabase.from('nurture_profiles')
        .select('health_score').eq('id', nurture_profile_id).single()
      if (prof) {
        await supabase.from('nurture_profiles').update({
          health_score: Math.max(0, (prof.health_score || 100) + penalty),
          updated_at: new Date().toISOString(),
        }).eq('id', nurture_profile_id)
      }
      } catch {} // don't fail the error handler
    }

    throw err
  } finally {
    await releaseSession(account_id, supabase)
  }
}

module.exports = nurtureFeed
