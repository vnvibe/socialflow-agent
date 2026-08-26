/**
 * Comment on a Facebook post handler
 * Navigates to post URL, finds comment box, types comment, submits
 */
const { getPage, releaseSession } = require('../../browser/session-pool')
const { delay, humanBrowse, humanMouseMove } = require('../../browser/human')
const { checkAccountStatus, saveDebugScreenshot } = require('./post-utils')
const guard = require('../../lib/checkpoint-guard')
const { recordSignal } = require('../../lib/signal-collector')

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

  // ─── PRE-FLIGHT CẦU DAO ───
  // Nick đã bị cầu dao ngắt (at_risk/checkpoint/disabled) → KHÔNG mở browser
  // comment nữa. Phòng trường hợp job này lọt qua trước khi poller kịp lọc.
  if (['at_risk', 'checkpoint', 'disabled', 'banned'].includes(account.status) || account.is_active === false) {
    throw new Error(`SKIP_nick_paused: ${account.status}`)
  }

  // ─── CHỐT CUỐI TRƯỚC KHI ĐĂNG ───
  //
  // Guard chống tự nhắc tên nick vốn nằm ở feed-seed (lúc SINH). Nhưng comment
  // tới đây qua NHIỀU đường — feed_seed, kpi-booster, camp, job tạo tay — nên
  // guard ở một đường không bảo vệ được các đường còn lại. Bằng chứng 25/08:
  // comment "Bấm link rồi vào server an ninh, Lorena cũng đã join rồi" đã đăng
  // thật, dù chạy qua guard thì bị bắt ngay. Đây là nơi DUY NHẤT mọi comment
  // đều đi qua, nên chốt đặt ở đây mới kín.
  //
  // Ném lỗi (không lặng lẽ bỏ) để job hiện rõ trong DB và health-check đếm được.
  const { mentionsOwnNick } = require('../../lib/ai-comment')
  const selfName = mentionsOwnNick(comment_text, account.username)
  if (selfName) {
    throw new Error(`SKIP_comment_mentions_own_nick: "${selfName}" — nick tự nhắc tên mình, lộ bot`)
  }

  // Comment PHẢI là tiếng Việt.
  //
  // Trước đây không có chốt cứng nào cho việc này: chỉ có prompt dặn model viết
  // tiếng Việt và AI gate chấm fluency — cả hai đều xác suất, model lỡ trả tiếng
  // Anh là đăng thẳng ra. (ai-brain còn có nhánh cho phép comment_language='en'
  // khi bài là tiếng Anh — đúng cho nhóm song ngữ, sai với camp tiếng Việt.)
  //
  // NGƯỠNG 25 KÝ TỰ, không phải 0: câu ngắn không đủ tín hiệu để nhận dạng —
  // đo thật "Hay quá bác" (11 ký tự, tiếng Việt) bị nhận nhầm là ngoại ngữ.
  // Câu ngắn cũng khó là cả câu ngoại ngữ nên bỏ qua là an toàn. Đo trên 36
  // comment thật 14 ngày: 0 câu bị chặn oan.
  // Chỉ bỏ qua khi job NÓI RÕ muốn ngôn ngữ khác (nhóm song ngữ). Vắng mặt =
  // mặc định tiếng Việt, vì đó là yêu cầu của camp đang chạy.
  const { isVietnamese: viCheck } = require('../../lib/feed-filter')
  const langYeuCau = payload.language || 'vi'
  if (langYeuCau === 'vi' && comment_text.trim().length >= 25 && !viCheck(comment_text)) {
    throw new Error(`SKIP_comment_not_vietnamese: "${comment_text.slice(0, 50)}"`)
  }

  return await postCommentInner(payload, supabase, account)
}

async function postCommentInner(payload, supabase, account) {
  const { account_id, post_url, fb_post_id, comment_text, source_name, job_id } = payload

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

      // Tự động phát hiện group và cập nhật is_member = false khi đéo comment được do không ở trong nhóm
      let gid = payload.fb_group_id
      if (!gid && post_url) {
        const gMatch = post_url.match(/groups\/([^/?]+)/)
        if (gMatch) gid = gMatch[1]
      }

      if (gid) {
        console.log(`[COMMENT-POST] ⚠️ Đéo thấy comment box trong nhóm ${gid}. Cập nhật is_member = false và lập lịch check_group_membership để tự động join lại.`)
        await supabase.from('fb_groups').update({
          is_member: false,
          pending_approval: false
        }).eq('account_id', account_id).eq('fb_group_id', gid)

        try {
          const { data: grp } = await supabase.from('fb_groups')
            .select('id, name, url')
            .eq('account_id', account_id)
            .eq('fb_group_id', gid)
            .single()

          if (grp) {
            await supabase.from('jobs').insert({
              type: 'check_group_membership',
              priority: 3,
              payload: {
                campaign_id: payload.campaign_id || null,
                account_id,
                fb_group_id: gid,
                group_row_id: grp.id,
                group_url: grp.url,
                group_name: grp.name,
                owner_id: account.owner_id,
                attempt: 1
              },
              status: 'pending',
              scheduled_at: new Date(Date.now() + 10 * 60000).toISOString(),
              created_by: account.owner_id
            })
            console.log(`[COMMENT-POST] Scheduled check_group_membership in 10min for recovery`)
          }
        } catch (jobErr) {
          console.warn(`[COMMENT-POST] Failed to schedule membership recovery: ${jobErr.message}`)
        }
      }

      throw new Error('Could not find comment input box (mobile). Nick might have been kicked or blocked from commenting in this group. Trạng thái nhóm đã được reset và lên lịch check/join lại.')
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

    // ═══ POST-SUBMIT VERIFICATION (Phase 2.4) ═══
    // Check for 3 failure signals BEFORE marking success:
    //   1. Checkpoint/error redirect
    //   2. FB error toast visible
    //   3. Comment text still stuck in input (submit silently failed)
    const submitVerify = await browserPage.evaluate((commentText) => {
      const url = location.href || ''
      const bodyText = (document.body?.innerText || '').substring(0, 500)

      // 1. Checkpoint or login redirect
      if (url.includes('checkpoint') || url.includes('/login')) {
        return { ok: false, reason: 'checkpoint_redirect', url }
      }

      // 2. Error toast — FB shows these as fixed-position overlays
      const errorPatterns = /couldn't post|không thể đăng|try again|thử lại|something went wrong|đã xảy ra lỗi|spam|temporarily blocked|tạm thời bị chặn/i
      if (errorPatterns.test(bodyText)) {
        // Check if it's in a toast/overlay (not just page content)
        const toasts = document.querySelectorAll('[role="alert"], [data-testid*="toast"], [data-testid*="error"]')
        for (const t of toasts) {
          if (errorPatterns.test(t.innerText || '')) {
            return { ok: false, reason: 'error_toast', message: (t.innerText || '').substring(0, 100) }
          }
        }
      }

      // 3. Comment still in input box (submit didn't go through)
      const inputs = document.querySelectorAll('textarea, [contenteditable="true"][role="textbox"]')
      for (const input of inputs) {
        const val = (input.value || input.innerText || '').trim()
        if (val && val.length > 10 && commentText.includes(val.substring(0, 20))) {
          return { ok: false, reason: 'text_still_in_input', text: val.substring(0, 50) }
        }
      }

      return { ok: true }
    }, comment_text).catch(() => ({ ok: true })) // on eval failure, assume OK

    if (!submitVerify.ok) {
      console.warn(`[COMMENT-POST] ⚠️ Submit verification FAILED: ${submitVerify.reason} — ${submitVerify.message || submitVerify.text || submitVerify.url || ''}`)

      // ─── CẦU DAO CHỐNG CHECKPOINT ───
      // Dấu hiệu cứng (redirect checkpoint HOẶC toast "tạm thời bị chặn"/spam)
      // → DỪNG NICK NGAY, không retry. Retry chỉ đổ thêm dầu vào lửa: FB đã
      // cảnh báo mềm, comment tiếp là leo thẳng lên checkpoint video (không cứu
      // được). Đây là mảnh phòng ngừa quan trọng nhất sau sự cố 14/08.
      const risk = guard.classifyRisk(submitVerify.message || submitVerify.text || '', submitVerify.url || '')
      if (submitVerify.reason === 'checkpoint_redirect' || risk.level === 'hard') {
        const reason = submitVerify.reason === 'checkpoint_redirect' ? 'checkpoint_redirect' : risk.reason
        await guard.tripBreaker(supabase, account_id, reason, {
          jobId: job_id, ownerId, recordSignal,
        })
        // Ném lỗi KHÔNG-retryable để dừng hẳn (isRetryable không khớp chuỗi này).
        throw new Error(`CIRCUIT_BREAKER_TRIPPED: ${reason}`)
      }
      throw new Error(`SUBMIT_FAILED:${submitVerify.reason}`)
    }

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

    // Bắt PERMALINK comment vừa đăng — nền tảng cho vòng "tìm & trả lời":
    // check_replies dùng link này để quay lại đúng comment và quét reply.
    // Bỏ id tạm client:<uuid> (FB hiển thị trước khi server cấp id thật —
    // pattern đã kiểm chứng ở campaign-nurture 11/08).
    let commentPermalink = null
    try {
      commentPermalink = await browserPage.evaluate((cmtPrefix) => {
        const links = Array.from(document.querySelectorAll('a[href*="comment_id="]'))
        if (!links.length) return null
        // Ưu tiên link nằm trong khối chứa đúng text comment của mình
        for (const a of links) {
          const box = a.closest('div')
          if (box && cmtPrefix && (box.textContent || '').includes(cmtPrefix)) {
            return a.href.split('&__cft__')[0]
          }
        }
        return links[links.length - 1].href.split('&__cft__')[0]   // comment mới nhất thường ở cuối
      }, (comment_text || '').slice(0, 40))
      if (commentPermalink && /comment_id=client(%3A|:)/i.test(commentPermalink)) commentPermalink = null
      if (commentPermalink) console.log(`[COMMENT-POST] 🔗 Permalink comment: ${commentPermalink.slice(0, 110)}`)
    } catch {}

    // Ghi ledger comment_logs — nguồn cho vòng TÌM & TRẢ LỜI (check_replies cron).
    if (commentLogId) {
      // Ca campaign/group: đã có row pending → UPDATE done + permalink.
      await supabase.from('comment_logs').update({
        status: 'done',
        finished_at: new Date().toISOString(),
        ...(commentPermalink ? { post_url: commentPermalink } : {}),
      }).eq('id', commentLogId).eq('owner_id', ownerId)
    } else {
      // Ca FEED: feed-seed chỉ ghi feed_actions, KHÔNG tạo comment_logs → trước
      // đây permalink mất + cron reply bỏ sót feed comment (bug 22/08). INSERT
      // row done để cron mine được (dedup theo unique idx account_id+fb_post_id
      // WHERE done → onConflict ignore, không nhân đôi khi retry).
      try {
        await supabase.from('comment_logs').insert({
          owner_id: ownerId,
          account_id,
          job_id: job_id || null,
          fb_post_id,
          post_url: commentPermalink || post_url || null,
          source_name: source_name || 'feed',
          comment_text,
          status: 'done',
          ai_generated: true,
          finished_at: new Date().toISOString(),
        })
      } catch (e) {
        if (!/duplicate|unique/i.test(e.message || '')) console.warn(`[COMMENT-POST] comment_logs insert lỗi: ${e.message}`)
      }
    }

    console.log(`[COMMENT-POST] ✅ Verified + Success! Commented on ${source_name || fb_post_id}`)

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
      actual_comments: 1,
      actual_likes: 0,
      actual_joins: 0,
      zero_action: false,
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
