/**
 * Handler: check_group_membership
 *
 * Re-verifies a group whose join request was previously detected as "pending
 * admin approval". The handler visits the group page and looks for a composer
 * box ("Bạn viết gì đi..." / "What's on your mind..."). If present, the nick
 * has been admitted. Otherwise, we look for "pending review" / "request sent"
 * to confirm it's still pending, or rejection markers.
 *
 * Updates fb_groups row accordingly:
 *   - admitted    → is_member=true,  pending_approval=false, joined_at=now()
 *   - still wait  → is_member=false, pending_approval=true   (no change)
 *   - rejected    → is_member=false, pending_approval=false, score_tier='D'
 */

const { getPage, releaseSession } = require('../../browser/session-pool')
const R = require('../../lib/randomizer')
const { checkAccountStatus } = require('./post-utils')

async function checkGroupMembershipHandler(payload, supabase) {
  const { account_id, fb_group_id, group_row_id, group_url, group_name } = payload
  if (!account_id || !fb_group_id) throw new Error('account_id and fb_group_id required')

  const { data: account } = await supabase
    .from('accounts').select('*, proxies(*)')
    .eq('id', account_id).single()
  if (!account) throw new Error('Account not found')

  // Lấy trạng thái hiện tại của group trong DB để so sánh sau này
  let currentGroupState = null
  try {
    if (group_row_id) {
      const { data } = await supabase.from('fb_groups')
        .select('id, is_member, pending_approval, score_tier')
        .eq('id', group_row_id)
        .single()
      currentGroupState = data
    } else {
      const { data } = await supabase.from('fb_groups')
        .select('id, is_member, pending_approval, score_tier')
        .eq('account_id', account_id)
        .eq('fb_group_id', fb_group_id)
        .single()
      currentGroupState = data
    }
  } catch (err) {
    console.warn(`[CHECK-MEMBER] Error fetching current group state: ${err.message}`)
  }

  let page, session
  try {
    session = await getPage(account, { headless: true })
    page = session.page

    const url = group_url || `https://www.facebook.com/groups/${fb_group_id}`
    console.log(`[CHECK-MEMBER] ${group_name || fb_group_id} — navigating...`)
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {})
    await R.sleepRange(3000, 5000)

    // 1. Chạy block-detector để phát hiện checkpoint/mất session
    const statusResult = await checkAccountStatus(page, supabase, account_id)
    if (statusResult.blocked) {
      throw new Error(`SKIP_check_membership: Tài khoản bị checkpoint hoặc hết hạn session (${statusResult.reason}). Bỏ qua kiểm tra nhóm để tránh đánh giá sai.`)
    }

    // 2. Xác thực DOM người dùng thực sự đã đăng nhập
    const isLoggedIn = await page.evaluate(() => {
      return !!document.querySelector('[aria-label="Your profile"], [aria-label="Account"], [data-pagelet="ProfileActions"], [aria-label="Trang cá nhân của bạn"], [aria-label="Tài khoản"], [aria-label="Thông báo"]')
    })
    if (!isLoggedIn) {
      throw new Error('SKIP_check_membership: Trình duyệt chưa đăng nhập (không thấy Profile Header). Bỏ qua kiểm tra nhóm để tránh đánh dấu sai.')
    }

    const status = await page.evaluate(() => {
      const text = document.body?.innerText || ''
      const html = document.documentElement.innerHTML || ''

      // Composer presence = admitted. Facebook renders the composer with an
      // aria-label containing "Write something" / "Bạn viết gì đi" / "Create a post".
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
        try {
          if (document.querySelector(sel)) { hasComposer = true; break }
        } catch {}
      }

      // Nút Joined / Member / Đã tham gia (đề phòng group khóa viết bài nhưng nick vẫn là member)
      const joinedBtnText = /\b(Joined|Member)\b/i.test(text) || text.toLowerCase().includes('đã tham gia')

      // Group bị lưu trữ hoặc khóa hẳn
      const isArchived = /archived|lưu trữ|đã lưu trữ/i.test(text)
      const isUnavailable = /content isn't available|nội dung này hiện không khả dụng|không thể xem nhóm/i.test(text)

      // Pending / request-sent markers
      const pendingMarkers = [
        /pending\s+review/i,
        /request\s+(to\s+join|sent|pending)/i,
        /chờ\s+(duyệt|phê\s+duyệt)/i,
        /đã\s+gửi\s+yêu\s+cầu/i,
        /awaiting/i,
      ]
      const isPending = pendingMarkers.some(p => p.test(text))

      // Rejection / removed markers
      const rejectMarkers = [
        /request\s+(declined|rejected)/i,
        /you\s+can'?t\s+(see|view)\s+this\s+group/i,
        /yêu\s+cầu\s+(bị\s+)?từ\s+chối/i,
        /bạn\s+không\s+thể\s+xem\s+nhóm/i,
        /this\s+content\s+isn'?t\s+available/i,
      ]
      const isRejected = rejectMarkers.some(p => p.test(text))

      // "Join group" button visible → we were removed / never joined
      const hasJoinButton = /Join\s+group|Tham\s+gia\s+nhóm/i.test(html) &&
        !!document.querySelector('div[aria-label*="Join" i][role="button"], div[aria-label*="Tham gia" i][role="button"]')

      return { hasComposer, joinedBtnText, isArchived, isUnavailable, isPending, isRejected, hasJoinButton, snippet: text.substring(0, 300) }
    }).catch(() => ({ hasComposer: false, joinedBtnText: false, isArchived: false, isUnavailable: false, isPending: false, isRejected: false, hasJoinButton: false, snippet: '' }))

    const attempt = payload.attempt || 1
    let updates = null
    let verdict = 'unknown'

    const confirmedMember = (status.hasComposer || status.joinedBtnText) && !status.isPending && !status.isArchived && !status.isUnavailable;
    const wasPending = currentGroupState?.pending_approval === true;
    const isActuallyNewOrNotJoined = !confirmedMember && !wasPending && status.hasJoinButton && !status.isArchived && !status.isUnavailable;

    if (confirmedMember) {
      verdict = 'admitted'
      updates = {
        is_member: true,
        join_status: 'member',
        pending_approval: false,
        is_blocked: false,
        blocked_reason: null,
        joined_at: new Date().toISOString(),
        pending_since: null,  // clear so daily cron skips
        membership_check_attempts: attempt,
        membership_last_checked_at: new Date().toISOString(),
      }
    } else if (status.isArchived || status.isUnavailable || status.isRejected || (!confirmedMember && status.hasJoinButton && wasPending)) {
      verdict = 'rejected_or_removed_or_unavailable'
      updates = {
        is_member: false,
        join_status: 'rejected',
        pending_approval: false,
        score_tier: 'D',
        membership_check_attempts: attempt,
        membership_last_checked_at: new Date().toISOString(),
      }
    } else if (isActuallyNewOrNotJoined) {
      verdict = 'not_joined_yet'
      updates = {
        is_member: false,
        join_status: 'not_joined',
        pending_approval: false,
        membership_check_attempts: attempt,
        membership_last_checked_at: new Date().toISOString(),
      }

      // Tự động lập lịch job join_group nếu nhóm này đang active trong campaign
      console.log(`[CHECK-MEMBER] Group ${fb_group_id} not joined yet. Scheduling join_group job for account ${account_id}...`)
      try {
        await supabase.from('jobs').insert({
          type: 'join_group',
          priority: 2,
          payload: {
            account_id,
            fb_group_id,
            group_url: group_url || `https://www.facebook.com/groups/${fb_group_id}`,
            campaign_id: payload.campaign_id || null,
            owner_id: account.owner_id,
            force_now: true,
          },
          status: 'pending',
          scheduled_at: new Date().toISOString(),
          created_by: account.owner_id,
        })
      } catch (schedErr) {
        console.warn(`[CHECK-MEMBER] Failed to schedule join_group job: ${schedErr.message}`)
      }
    } else if (status.isPending || verdict === 'unknown') {
      verdict = status.isPending ? 'still_pending' : 'ambiguous'

      updates = {
        membership_check_attempts: attempt,
        membership_last_checked_at: new Date().toISOString(),
      }

      const groupRowId = group_row_id || null
      if (groupRowId) {
        try {
          const { data: grp } = await supabase.from('fb_groups')
            .select('pending_since, created_at').eq('id', groupRowId).single()
          const startTs = grp?.pending_since || grp?.created_at
          const daysPending = startTs
            ? (Date.now() - new Date(startTs).getTime()) / 86400000
            : 0
          if (daysPending >= 7) {
            verdict = 'pending_too_long_handover_user'
            updates.score_tier = 'D'
            console.log(`[CHECK-MEMBER] ${group_name || fb_group_id} pending ${daysPending.toFixed(1)}d ≥ 7d → handover to user (no more auto-check)`)
          } else {
            console.log(`[CHECK-MEMBER] ${group_name || fb_group_id} → still_pending (day ${daysPending.toFixed(1)}/7) → daily cron will re-check`)
          }
        } catch {}
      }
    }

    // Apply updates
    if (updates) {
      if (group_row_id) {
        await supabase.from('fb_groups').update(updates).eq('id', group_row_id)
      } else {
        await supabase.from('fb_groups').update(updates)
          .eq('account_id', account_id).eq('fb_group_id', fb_group_id)
      }
    }

    // Sync to campaign_groups table
    const gRowId = group_row_id || currentGroupState?.id
    if (gRowId && updates) {
      try {
        const cgUpdates = {}
        if (updates.score_tier) cgUpdates.tier = updates.score_tier
        if (updates.is_member === false) cgUpdates.status = 'paused'
        
        if (Object.keys(cgUpdates).length > 0) {
          await supabase.from('campaign_groups')
            .update(cgUpdates)
            .eq('group_id', gRowId)
          console.log(`[CHECK-MEMBER] Synced campaign_groups status/tier for group ${gRowId}:`, cgUpdates)
        }
      } catch (cgErr) {
        console.warn(`[CHECK-MEMBER] Failed to sync to campaign_groups: ${cgErr.message}`)
      }
    }

    // If admitted, also activate the campaign_groups junction row for all campaigns
    if (verdict === 'admitted' && gRowId) {
      try {
        await supabase.from('campaign_groups')
          .update({ status: 'active' })
          .eq('group_id', gRowId)
      } catch (actErr) {
        console.warn(`[CHECK-MEMBER] Failed to activate campaign_groups rows: ${actErr.message}`)
      }
    }

    console.log(`[CHECK-MEMBER] ${group_name || fb_group_id} → ${verdict}`)
    return { success: true, verdict, attempt, updated: !!updates, snippet: status.snippet.substring(0, 120) }
  } finally {
    if (session) await releaseSession(account_id).catch(() => {})
  }
}

module.exports = checkGroupMembershipHandler
