/**
 * Discover new Facebook groups by keyword
 * Tìm kiếm groups mới trên Facebook theo từ khoá
 */
const { getPage, releaseSession } = require('../../browser/session-pool')
const { delay, humanScroll, humanMouseMove, humanBrowse } = require('../../browser/human')
const { checkAccountStatus, saveDebugScreenshot } = require('./post-utils')
const { filterRelevantGroups } = require('../../lib/ai-filter')

async function discoverGroupsKeywordHandler(payload, supabase) {
  const { account_id, keyword, keyword_id, owner_id } = payload

  if (!keyword) throw new Error('keyword required')
  if (!account_id) throw new Error('account_id required')

  // Get account
  const { data: account } = await supabase.from('accounts').select('*, proxies(*)')
    .eq('id', account_id).single()
  if (!account) throw new Error('Account not found')

  let browserPage
  let totalFound = 0
  let newGroups = 0

  try {
    const session = await getPage(account)
    browserPage = session.page

    console.log(`[DISCOVER-GROUPS] Searching for groups with keyword: "${keyword}"`)

    // Check checkpoint first
    await browserPage.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 30000 })
    await delay(2000, 4000)
    const status = await checkAccountStatus(browserPage, supabase, account_id)
    if (status.blocked) throw new Error(`Account blocked: ${status.detail}`)

    // Navigate to Facebook group search
    const searchUrl = `https://www.facebook.com/search/groups/?q=${encodeURIComponent(keyword)}`
    await browserPage.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await delay(3000, 5000)

    // Check if we got redirected
    const currentUrl = browserPage.url()
    if (currentUrl.includes('/login') || currentUrl.includes('/checkpoint')) {
      throw new Error('Redirected to login/checkpoint during search')
    }

    // Browse naturally
    await humanBrowse(browserPage, 2)

    // Scroll and collect groups
    const groups = await scrollAndExtractGroups(browserPage)
    totalFound = groups.length

    console.log(`[DISCOVER-GROUPS] Found ${totalFound} groups for "${keyword}"`)

    // AI relevance filter
    const relevantGroups = await filterRelevantGroups(groups, keyword, owner_id)
    console.log(`[DISCOVER-GROUPS] ${relevantGroups.length}/${groups.length} groups passed AI relevance check`)
    totalFound = relevantGroups.length

    // Upsert discovered groups
    for (const group of relevantGroups) {
      try {
        const { error } = await supabase.from('discovered_groups').upsert({
          owner_id,
          keyword_id,
          fb_group_id: group.fb_group_id,
          name: group.name,
          member_count: group.member_count,
          group_type: group.group_type,
          url: group.url,
          description: group.description,
          discovered_at: new Date().toISOString(),
        }, { onConflict: 'owner_id,fb_group_id', ignoreDuplicates: true })

        if (!error) newGroups++
      } catch (e) {
        console.log(`[DISCOVER-GROUPS] Upsert error: ${e.message}`)
      }
    }

    console.log(`[DISCOVER-GROUPS] Done! Found ${totalFound} groups, ${newGroups} new`)
    return { total_found: totalFound, new_groups: newGroups }

  } catch (err) {
    console.error(`[DISCOVER-GROUPS] Error: ${err.message}`)
    if (browserPage) await saveDebugScreenshot(browserPage, `discover-groups-error-${account_id}`)
    throw err
  } finally {
    // Keep page on FB for session reuse
    releaseSession(account_id)
  }
}

/**
 * Scroll search results and extract group data
 */
async function scrollAndExtractGroups(page) {
  const groups = []
  const seen = new Set()
  let noNewCount = 0
  const MAX_SCROLLS = 30
  const MAX_NO_NEW = 4

  for (let i = 0; i < MAX_SCROLLS; i++) {
    // Extract groups from DOM
    const extracted = await page.evaluate(() => {
      const results = []
      const container = document.querySelector('[role="main"]') || document.body

      // Find group links in search results
      const groupLinks = container.querySelectorAll('a[href*="/groups/"]')

      for (const link of groupLinks) {
        const href = link.href || ''
        // Extract group ID from URL
        const groupMatch = href.match(/\/groups\/(\d+)/) || href.match(/\/groups\/([^/?]+)/)
        if (!groupMatch) continue

        const fbGroupId = groupMatch[1]
        // Skip non-group URLs
        if (['joins', 'feed', 'search', 'discover', 'create'].includes(fbGroupId)) continue

        // Walk up to find the result card container
        let card = link
        for (let j = 0; j < 8; j++) {
          if (!card.parentElement) break
          card = card.parentElement
          if (card.innerText?.length > 30) break
        }

        const text = card?.innerText || ''
        if (text.length < 10) continue

        // Extract group name (usually the first text in the card, or the link text)
        const nameEl = card.querySelector('span[dir="auto"]') || card.querySelector('strong') || link
        const name = nameEl?.textContent?.trim()
        if (!name || name.length < 2) continue

        // Extract member count
        let memberCount = 0
        const memberMatch = text.match(/(\d+(?:[\.,]\d+)?)\s*[KkMm]?\s*(?:members?|thành viên)/i)
        if (memberMatch) {
          let numStr = memberMatch[0]
          const numPart = memberMatch[1].replace(/,/g, '.')
          if (/[kK]/.test(numStr)) memberCount = Math.round(parseFloat(numPart) * 1000)
          else if (/[mM]/.test(numStr)) memberCount = Math.round(parseFloat(numPart) * 1000000)
          else memberCount = parseInt(numPart.replace('.', '')) || 0
        }

        // Extract group type
        let groupType = 'public'
        if (/private|riêng tư|kín/i.test(text)) groupType = 'private'

        // Extract description (text after name and before member count)
        const lines = text.split('\n').filter(l => l.trim().length > 0)
        const description = lines.slice(1, 4).join(' ').substring(0, 500)

        results.push({
          fb_group_id: fbGroupId,
          name,
          member_count: memberCount,
          group_type: groupType,
          url: `https://www.facebook.com/groups/${fbGroupId}`,
          description,
        })
      }

      return results
    })

    // Add new groups
    let hasNew = false
    for (const group of extracted) {
      if (!seen.has(group.fb_group_id)) {
        seen.add(group.fb_group_id)
        groups.push(group)
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

    if (Math.random() < 0.3) await humanMouseMove(page)
  }

  return groups
}

module.exports = discoverGroupsKeywordHandler
