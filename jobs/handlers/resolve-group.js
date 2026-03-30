const { getPage, releaseSession } = require('../../browser/session-pool')
const { delay } = require('../../browser/human')

/**
 * Resolve group info từ URL/ID
 * Payload: { account_id, groups: [{ id (db id), fb_group_id, url }] }
 * Mỗi group sẽ được visit để lấy name, member_count, group_type
 */
async function resolveGroupHandler(payload, supabase) {
  const { account_id, groups } = payload
  if (!groups?.length) throw new Error('No groups to resolve')

  const { data: account } = await supabase
    .from('accounts')
    .select('*, proxies(*)')
    .eq('id', account_id)
    .single()

  if (!account) throw new Error('Account not found')

  let page
  try {
    // Chạy headless - không chiếm màn hình
    const session = await getPage(account, { headless: true })
    page = session.page

    const results = []

    for (const group of groups) {
      try {
        const groupUrl = group.url || `https://www.facebook.com/groups/${group.fb_group_id}`
        console.log(`[RESOLVE-GROUP] Visiting ${groupUrl}`)

        await page.goto(groupUrl, { waitUntil: 'domcontentloaded', timeout: 20000 })
        await delay(2000, 4000)

        // Extract group info từ page
        const info = await page.evaluate(() => {
          const src = document.documentElement.innerHTML
          const result = {}

          // Lấy tên group
          // Strategy 1: h1 hoặc heading text
          const h1 = document.querySelector('h1')
          if (h1) result.name = h1.textContent?.trim()

          // Strategy 2: meta tag
          if (!result.name) {
            const ogTitle = document.querySelector('meta[property="og:title"]')
            if (ogTitle) result.name = ogTitle.getAttribute('content')?.trim()
          }

          // Strategy 3: GraphQL data
          if (!result.name) {
            const nameMatch = src.match(/"groupName"\s*:\s*"([^"]+)"/) ||
                              src.match(/"name"\s*:\s*"([^"]+)"[^}]*?"groupID"/)
            if (nameMatch) result.name = nameMatch[1]
          }

          // Lấy group ID từ URL nếu chưa có
          const idMatch = window.location.href.match(/\/groups\/(\d+)/) ||
                          src.match(/"groupID"\s*:\s*"(\d+)"/)
          if (idMatch) result.fb_group_id = idMatch[1]

          // Lấy member count
          const memberMatch = src.match(/"member_count"\s*:\s*(\d+)/) ||
                              src.match(/"group_total_members_info_text"\s*:\s*"([^"]+)"/)
          if (memberMatch) {
            const num = parseInt(memberMatch[1].replace(/\D/g, ''))
            if (!isNaN(num)) result.member_count = num
          }

          // Lấy group type (public/closed/secret)
          if (/("privacy"\s*:\s*"CLOSED"|"group_type"\s*:\s*"CLOSED"|nhóm riêng tư|private group)/i.test(src)) {
            result.group_type = 'closed'
          } else if (/("privacy"\s*:\s*"SECRET"|nhóm bí mật|secret group)/i.test(src)) {
            result.group_type = 'secret'
          } else {
            result.group_type = 'public'
          }

          // Decode unicode
          if (result.name) {
            result.name = result.name.replace(/\\u[\dA-Fa-f]{4}/g, m => String.fromCharCode(parseInt(m.slice(2), 16)))
          }

          return result
        })

        console.log(`[RESOLVE-GROUP] Found: ${info.name || '(no name)'} (${info.fb_group_id || group.fb_group_id})`)

        // Update DB record
        const updates = {}
        if (info.name) updates.name = info.name
        if (info.fb_group_id && info.fb_group_id !== group.fb_group_id) updates.fb_group_id = info.fb_group_id
        if (info.member_count) updates.member_count = info.member_count
        if (info.group_type) updates.group_type = info.group_type
        if (!group.url && info.fb_group_id) updates.url = `https://www.facebook.com/groups/${info.fb_group_id}`

        if (Object.keys(updates).length > 0 && group.id) {
          await supabase.from('fb_groups').update(updates).eq('id', group.id)
        }

        results.push({ id: group.id, fb_group_id: info.fb_group_id || group.fb_group_id, name: info.name, success: true })
      } catch (err) {
        console.error(`[RESOLVE-GROUP] Error for ${group.fb_group_id}: ${err.message}`)
        results.push({ id: group.id, fb_group_id: group.fb_group_id, success: false, error: err.message })
      }

      // Delay giữa mỗi group để tự nhiên hơn
      if (groups.indexOf(group) < groups.length - 1) {
        await delay(1500, 3000)
      }
    }

    // Close page
    // Keep page on FB for session reuse
    releaseSession(account_id)

    const successCount = results.filter(r => r.success).length
    console.log(`[RESOLVE-GROUP] Done: ${successCount}/${groups.length} resolved`)
    return { resolved: successCount, total: groups.length, results }
  } catch (err) {
    if (page) // Keep page on FB for session reuse
    releaseSession(account_id)
    throw err
  }
}

module.exports = resolveGroupHandler
