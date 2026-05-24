const { getPage, releaseSession } = require('../../browser/session-pool')
const { delay, humanClick, humanMouseMove } = require('../../browser/human')
const R = require('../../lib/randomizer')
const { generateMembershipAnswer } = require('../../lib/ai-brain')
const { evaluateGroup, extractGroupInfo } = require('../../lib/ai-filter')

const JOIN_SELECTORS = [
  '[aria-label="Join group"]',
  '[aria-label="Tham gia nhóm"]',
  '[aria-label="Join Group"]',
  '[aria-label="Tham gia"]',
  'div[role="button"]:has-text("Join group")',
  'div[role="button"]:has-text("Tham gia nhóm")',
  'div[role="button"]:has-text("Tham gia")',
  'div[role="button"]:has-text("Join")',
]

async function joinGroupHandler(payload, supabase) {
  const { account_id, group_url, fb_group_id, discovered_group_id, campaign_id } = payload
  if (!account_id || (!fb_group_id && !group_url)) throw new Error('account_id and fb_group_id/group_url are required')

  const { data: account } = await supabase
    .from('accounts')
    .select('*, proxies(*)')
    .eq('id', account_id)
    .single()

  if (!account) throw new Error('Account not found')

  let page
  try {
    const session = await getPage(account)
    page = session.page

    const url = group_url || `https://www.facebook.com/groups/${fb_group_id}`
    const gid = fb_group_id || url.match(/\/groups\/([^/?]+)/)?.[1]
    
    console.log(`[JOIN-GROUP] Navigating to group URL: ${url}`)
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await delay(3000, 6000)
    await humanMouseMove(page)

    // ── logic kiểm tra trạng thái thành viên DOM 3 chiều ──
    const detectMembershipState = async () => {
      return page.evaluate(() => {
        const text = document.body?.innerText?.substring(0, 1500) || ''
        const isPendingText = /pending\s+review|chờ\s+(duyệt|phê\s+duyệt)|waiting.*approval|awaiting|đã\s+gửi\s+yêu\s+cầu|request\s+sent/i.test(text)
        
        // Phát hiện composer viết bài
        const composerSelectors = [
          '[aria-label*="Write something" i]',
          '[aria-label*="Viết bài" i]',
          '[aria-label*="Bạn viết gì" i]',
          '[aria-label*="Create a post" i]',
          '[aria-label*="Tạo bài viết" i]',
          '[role="textbox"][contenteditable="true"]',
        ]
        let hasComposer = false
        for (const sel of composerSelectors) {
          try { if (document.querySelector(sel)) { hasComposer = true; break } } catch {}
        }
        
        // Nút Joined / Member
        const joinedBtnText = /\b(Joined|Đã tham gia|Member)\b/i.test(text)
        return { isPendingText, hasComposer, joinedBtnText }
      }).catch(() => ({ isPendingText: false, hasComposer: false, joinedBtnText: false }))
    }

    let membershipState = await detectMembershipState()
    let isPending = membershipState.isPendingText
    let confirmedMember = (membershipState.hasComposer || membershipState.joinedBtnText) && !isPending

    if (confirmedMember) {
      console.log(`[JOIN-GROUP] Already a member of group: ${url}`)
      await updateDbStatus(supabase, account_id, gid, url, true, false, discovered_group_id, campaign_id)
      return { success: true, status: 'already_member', group_url: url }
    }

    if (isPending) {
      console.log(`[JOIN-GROUP] Join request already sent and pending admin approval: ${url}`)
      await updateDbStatus(supabase, account_id, gid, url, false, true, discovered_group_id, campaign_id)
      return { success: true, status: 'already_requested_pending', group_url: url }
    }

    // ── Tìm nút Join group ──
    let joinBtn = null
    for (const sel of JOIN_SELECTORS) {
      try {
        joinBtn = await page.$(sel)
        if (joinBtn) break
      } catch {}
    }

    if (!joinBtn) {
      // Fallback: locator text search
      try {
        const loc = page.locator('div[role="button"]:has-text("Tham gia"), div[role="button"]:has-text("Join")').first()
        if (await loc.isVisible({ timeout: 2000 })) joinBtn = await loc.elementHandle()
      } catch {}
    }

    if (!joinBtn) {
      throw new Error('Join button not found on group page')
    }

    await joinBtn.scrollIntoViewIfNeeded()
    await delay(500, 1200)
    await humanClick(page, joinBtn)
    await delay(2500, 4500) // Đợi hộp thoại câu hỏi hiện lên

    // ── XỬ LÝ CÂU HỎI PHÊ DUYỆT BẰNG AI (MEMBERSHIP QUESTIONS) ──
    let questionsAnswered = 0
    try {
      const questionData = await page.evaluate(() => {
        const dialog = document.querySelector('div[role="dialog"]')
        if (!dialog) return null

        const dialogText = dialog.innerText || ''
        const looksLikeQuestions = /câu hỏi|question|trả lời|answer|membership/i.test(dialogText)
        if (!looksLikeQuestions) return null

        const questions = []
        const inputs = dialog.querySelectorAll('textarea, input[type="text"]')
        for (const input of inputs) {
          let label = ''
          let parent = input.parentElement
          for (let i = 0; i < 6 && parent; i++) {
            const text = (parent.innerText || '').split('\n').filter(t => t.length > 5 && t.length < 300)
            if (text.length > 0) {
              const candidate = text.find(t => !t.includes(input.placeholder || '___NONE___'))
              if (candidate && candidate.length > 10) { label = candidate; break }
            }
            parent = parent.parentElement
          }
          if (label) {
            input.setAttribute('data-membership-q-idx', String(questions.length))
            questions.push(label.substring(0, 250).trim())
          }
        }
        return { questions }
      })

      if (questionData?.questions?.length > 0) {
        console.log(`[JOIN-GROUP] Membership questions detected: ${questionData.questions.length}`)

        // Lấy group description
        const groupDesc = await page.evaluate(() => {
          const aboutEl = document.querySelector('[data-testid="group-about-card"]')
          return aboutEl ? (aboutEl.innerText || '').substring(0, 300) : ''
        }).catch(() => '')

        // Đọc tên nhóm
        const groupName = await page.title().catch(() => 'Facebook Group')

        // Gọi AI Hermes tạo câu trả lời
        const answers = await generateMembershipAnswer(
          questionData.questions,
          {
            name: groupName,
            topic: '',
            description: groupDesc,
            language: 'vi',
          },
          account.owner_id
        )

        // Điền câu trả lời
        for (let i = 0; i < answers.length; i++) {
          const ans = answers[i]?.answer || ''
          if (!ans) continue
          try {
            const selector = `[data-membership-q-idx="${i}"]`
            await page.fill(selector, ans, { timeout: 3000 })
            await delay(800, 1800)
            questionsAnswered++
          } catch (fillErr) {
            console.warn(`[JOIN-GROUP] Could not fill answer #${i}: ${fillErr.message}`)
          }
        }
        console.log(`[JOIN-GROUP] Filled ${questionsAnswered}/${answers.length} answers via AI`)
        await delay(1500, 3000)
      }
    } catch (qErr) {
      console.warn(`[JOIN-GROUP] Membership question handling failed: ${qErr.message}`)
    }

    // Submit form gia nhập
    const submitBtn = await page.$('div[aria-label="Submit"], div[aria-label="Gửi"], div[role="button"]:has-text("Submit"), div[role="button"]:has-text("Gửi")')
    if (submitBtn) {
      await delay(1000, 2000)
      await humanClick(page, submitBtn)
      await delay(2000, 4000)
    }

    // Xác nhận lại trạng thái sau khi Join click
    membershipState = await detectMembershipState()
    isPending = membershipState.isPendingText
    confirmedMember = (membershipState.hasComposer || membershipState.joinedBtnText) && !isPending

    const statusVerdict = confirmedMember ? 'joined' : 'requested'
    console.log(`[JOIN-GROUP] Join request submitted! Verdict: ${statusVerdict} for ${url}`)

    // Lưu DB
    const upsertedId = await updateDbStatus(
      supabase,
      account_id,
      gid,
      url,
      confirmedMember,
      !confirmedMember,
      discovered_group_id,
      campaign_id
    )

    // Nếu pending, lập lịch tự động check membership sau 20 phút
    if (!confirmedMember && upsertedId) {
      try {
        await supabase.from('jobs').insert({
          type: 'check_group_membership',
          priority: 3,
          payload: {
            fb_group_id: gid,
            group_row_id: upsertedId,
            account_id,
            group_name: url,
            campaign_id: campaign_id || null,
            attempt: 1,
          },
          status: 'pending',
          scheduled_at: new Date(Date.now() + 20 * 60 * 1000).toISOString(),
        })
        console.log(`[JOIN-GROUP] Scheduled membership check job in 20min`)
      } catch (jobErr) {
        console.warn(`[JOIN-GROUP] Failed to schedule membership check: ${jobErr.message}`)
      }
    }

    return { success: true, status: statusVerdict, group_url: url }
  } finally {
    releaseSession(account_id, supabase)
  }
}

/**
 * Cập nhật trạng thái join group vào bảng fb_groups và discovered_groups
 */
async function updateDbStatus(supabase, accountId, gid, url, isMember, pendingApproval, discoveredGroupId, campaignId) {
  let groupRowId = null
  try {
    // 1. Cập nhật discovered_groups nếu có
    if (discoveredGroupId) {
      await supabase.from('discovered_groups')
        .update({ join_status: isMember ? 'joined' : 'requested' })
        .eq('id', discoveredGroupId)
    }

    // 2. Cập nhật fb_groups (global pool)
    const upsertPayload = {
      account_id: accountId,
      fb_group_id: gid,
      url,
      is_member: isMember,
      pending_approval: pendingApproval,
      joined_at: isMember ? new Date().toISOString() : null,
      pending_since: pendingApproval ? new Date().toISOString() : null,
    }

    const { data: upserted } = await supabase.from('fb_groups')
      .upsert(upsertPayload, { onConflict: 'account_id,fb_group_id' })
      .select('id').single()

    if (upserted?.id) {
      groupRowId = upserted.id
      
      // 3. Cập nhật campaign_groups junction nếu có campaign_id
      if (campaignId) {
        await supabase.from('campaign_groups').upsert({
          campaign_id: campaignId,
          group_id: groupRowId,
          assigned_nick_id: accountId,
          status: isMember ? 'active' : 'paused',
        }, { onConflict: 'campaign_id,group_id' })
      }
    }

    // 4. Gọi RPC append campaign nếu có campaign_id
    if (campaignId) {
      await supabase.rpc('append_campaign_to_group', {
        p_account_id: accountId,
        p_fb_group_id: gid,
        p_campaign_id: campaignId,
      }).catch(() => {})
    }
  } catch (err) {
    console.warn(`[JOIN-GROUP] DB update warning: ${err.message}`)
  }
  return groupRowId
}

module.exports = joinGroupHandler
