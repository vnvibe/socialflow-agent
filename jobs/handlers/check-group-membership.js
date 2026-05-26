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
      const joinedBtnText = /\b(Joined|Đã tham gia|Member)\b/i.test(text)

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

    const confirmedMember = (status.hasComposer || status.joinedBtnText) && !status.isPending && !status.hasJoinButton && !status.isArchived && !status.isUnavailable;

    if (confirmedMember) {
      verdict = 'admitted'
      updates = {
        is_member: true,
        pending_approval: false,
        joined_at: new Date().toISOString(),
        pending_since: null,  // clear so daily cron skips
        membership_check_attempts: attempt,
        membership_last_checked_at: new Date().toISOString(),
      }
    } else if (status.isRejected || status.hasJoinButton || status.isArchived || status.isUnavailable) {
      verdict = 'rejected_or_removed_or_unavailable'
      updates = {
        is_member: false,
        pending_approval: false,
        score_tier: 'D',
        membership_check_attempts: attempt,
        membership_last_checked_at: new Date().toISOString(),
      }
    } else if (status.isPending || verdict === 'unknown') {
      verdict = status.isPending ? 'still_pending' : 'ambiguous'

      updates = {
        membership_check_attempts: attempt,
        membership_last_checked_at: new Date().toISOString(),
      }

      // 2026-05-02: replaced exponential backoff (20m→1h→2h→6h→24h, max 5
      // attempts) with daily-only cron + 7-day cap (per user spec).
      // Behavior:
      //   - Pending < 7 days → keep pending_approval=true, daily cron will
      //     re-queue tomorrow (NO self-requeue here, save jobs queue churn)
      //   - Pending >= 7 days → stop auto-checking, leave pending_approval=true
      //     so frontend "Pending" tab can list it for user manual action
      //     (e.g. user can click "Re-request join" or remove it)
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
            // Mark the handover by setting score_tier='D' so daily cron
            // SQL filter `neq score_tier 'D'` excludes it next time.
            // pending_approval stays TRUE so frontend can list in pending tab.
            updates.score_tier = 'D'
            console.log(`[CHECK-MEMBER] ${group_name || fb_group_id} pending ${daysPending.toFixed(1)}d ≥ 7d → handover to user (no more auto-check)`)
          } else {
            console.log(`[CHECK-MEMBER] ${group_name || fb_group_id} → still_pending (day ${daysPending.toFixed(1)}/7) → daily cron will re-check`)
          }
        } catch {}
      }
      // No self-requeue — daily cron in nurture-scheduler.js handles next iter.
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

    // If admitted, also activate the campaign_groups junction row
    if (verdict === 'admitted' && payload.campaign_id && group_row_id) {
      try {
        await supabase.from('campaign_groups')
          .update({ status: 'active' })
          .eq('campaign_id', payload.campaign_id)
          .eq('group_id', group_row_id)
      } catch {}
    }

    console.log(`[CHECK-MEMBER] ${group_name || fb_group_id} → ${verdict}`)
    return { success: true, verdict, attempt, updated: !!updates, snippet: status.snippet.substring(0, 120) }
  } finally {
    if (session) await releaseSession(account_id).catch(() => {})
  }
}

module.exports = checkGroupMembershipHandler
