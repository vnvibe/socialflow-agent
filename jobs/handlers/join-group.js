const { getPage, releaseSession } = require('../../browser/session-pool')
const { delay, humanClick } = require('../../browser/human')

const JOIN_SELECTORS = [
  '[aria-label="Join group"]',
  '[aria-label="Tham gia nhóm"]',
  '[aria-label="Join Group"]',
  'div[role="button"]:has-text("Join group")',
  'div[role="button"]:has-text("Tham gia nhóm")',
]

async function joinGroupHandler(payload, supabase) {
  const { account_id, group_url, fb_group_id, discovered_group_id } = payload

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
    console.log(`[JOIN-GROUP] Navigating to ${url}`)
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await delay(3000, 5000)

    // Tìm nút Join group
    let joinBtn = null
    for (const sel of JOIN_SELECTORS) {
      try {
        joinBtn = await page.$(sel)
        if (joinBtn) break
      } catch {}
    }

    if (!joinBtn) {
      // Kiểm tra đã join chưa (nút "Joined" hoặc "Đã tham gia")
      const alreadyJoined = await page.$('[aria-label="Joined"], [aria-label="Đã tham gia"], [aria-label="Member"]').catch(() => null)
      if (alreadyJoined) {
        console.log(`[JOIN-GROUP] Already a member of ${url}`)
        if (discovered_group_id) {
          await supabase.from('discovered_groups').update({ join_status: 'joined' }).eq('id', discovered_group_id).catch(() => {})
        }
        return { success: true, status: 'already_member' }
      }
      throw new Error('Join button not found on group page')
    }

    await joinBtn.scrollIntoViewIfNeeded()
    await delay(500, 1000)
    await humanClick(page, joinBtn)
    await delay(2000, 4000)

    console.log(`[JOIN-GROUP] Join request sent for ${url}`)

    // Update trạng thái trong DB
    if (discovered_group_id) {
      await supabase.from('discovered_groups').update({ join_status: 'requested' }).eq('id', discovered_group_id).catch(() => {})
    }

    return { success: true, status: 'requested', group_url: url }
  } finally {
    if (page) await page.goto('about:blank', { timeout: 3000 }).catch(() => {})
    releaseSession(account_id)
  }
}

module.exports = joinGroupHandler
