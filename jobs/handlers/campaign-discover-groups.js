/**
 * Campaign Handler: Discover Groups (Role: scout)
 * Search groups by topic, join, scan members → feed target_queue
 * Uses 3-layer extraction: GraphQL interception → Regex fallback → DOM links
 */

const { getPage, releaseSession } = require('../../browser/session-pool')
const { delay, humanScroll, humanMouseMove, humanClick } = require('../../browser/human')
const { saveDebugScreenshot } = require('./post-utils')
const { checkHardLimit, applyAgeFactor } = require('../../lib/hard-limits')
const R = require('../../lib/randomizer')
const { getActionParams } = require('../../lib/plan-executor')
const { filterRelevantGroups } = require('../../lib/ai-filter')
const { ActivityLogger } = require('../../lib/activity-logger')

// System paths to skip (not real groups)
const SYSTEM_PATHS = new Set([
  'discover', 'feed', 'create', 'joins', 'search', 'notifications',
  'settings', 'your_groups', 'suggested', 'browse', 'new', 'people',
])

/**
 * Extract groups from GraphQL JSON responses intercepted during page load
 * This is the MOST RELIABLE method — FB embeds structured data in responses
 */
function extractGroupsFromResponses(responses) {
  const collected = new Map()

  for (const text of responses) {
    try {
      const json = JSON.parse(text)
      walkJson(json, (obj) => {
        if (!obj || typeof obj !== 'object') return
        const id = obj.id || obj.groupID || obj.group_id
        if (!id) return
        const idStr = String(id)

        const isGroup = obj.__typename === 'Group'
          || obj.group_id || obj.groupID
          || obj.member_count !== undefined
          || obj.group_privacy
          || obj.group_member_count !== undefined
        if (!isGroup) return

        const entry = collected.get(idStr) || { fb_group_id: idStr }
        if (obj.name) entry.name = obj.name
        if (obj.member_count != null) entry.member_count = Number(obj.member_count)
        if (obj.group_member_count != null) entry.member_count = entry.member_count || Number(obj.group_member_count)
        if (obj.group_privacy) {
          const p = String(obj.group_privacy).toLowerCase()
          entry.group_type = (p === 'open' || p === 'public') ? 'public' : 'closed'
        }
        entry.url = `https://www.facebook.com/groups/${idStr}`
        collected.set(idStr, entry)
      })
    } catch {
      // JSON parse fail → try regex
      extractGroupsRegex(text, collected)
    }
  }

  return [...collected.values()].filter(g => g.name && g.name.length > 2)
}

/** Regex fallback: extract group data from raw text */
function extractGroupsRegex(text, collected) {
  // Match groupID fields
  for (const m of text.matchAll(/"groupID"\s*:\s*"(\d{5,})"/g)) {
    if (!collected.has(m[1])) collected.set(m[1], { fb_group_id: m[1] })
  }
  // Match full Group objects
  for (const m of text.matchAll(/\{[^{}]{0,3000}?"id"\s*:\s*"(\d{5,})"[^{}]{0,3000}?\}/g)) {
    const block = m[0], id = m[1]
    if (!block.includes('"Group"') && !block.includes('"groupID"') && !block.includes('"member_count"') && !block.includes('"group_privacy"')) continue
    const entry = collected.get(id) || { fb_group_id: id }
    const nameMatch = block.match(/"name"\s*:\s*"([^"]{2,150})"/)
    if (nameMatch) entry.name = nameMatch[1].replace(/\\u[\dA-Fa-f]{4}/g, m => String.fromCharCode(parseInt(m.slice(2), 16)))
    const memberMatch = block.match(/"(?:member_count|group_member_count)"\s*:\s*(\d+)/)
    if (memberMatch) entry.member_count = parseInt(memberMatch[1])
    entry.url = `https://www.facebook.com/groups/${id}`
    collected.set(id, entry)
  }
}

/** Walk JSON tree recursively */
function walkJson(obj, fn, depth = 0) {
  if (depth > 15 || obj === null || obj === undefined) return
  if (typeof obj === 'object') {
    fn(obj)
    if (Array.isArray(obj)) {
      for (const item of obj) walkJson(item, fn, depth + 1)
    } else {
      for (const val of Object.values(obj)) walkJson(val, fn, depth + 1)
    }
  }
}

/**
 * DOM fallback: extract groups from visible links on the page
 * Used when GraphQL interception returns nothing
 */
async function extractGroupsFromDOM(page) {
  return page.evaluate((systemPaths) => {
    const results = []
    const links = document.querySelectorAll('a[href*="/groups/"]')
    const seen = new Set()

    for (const link of links) {
      const href = link.href
      const match = href.match(/\/groups\/([\w.-]+)/)
      if (!match) continue
      const groupId = match[1]
      if (systemPaths.includes(groupId.toLowerCase())) continue
      if (seen.has(groupId)) continue
      seen.add(groupId)

      // Get name — skip utility links with no real text
      const name = link.textContent?.trim() || ''
      if (!name || name.length <= 2) continue
      const skipPatterns = /^(xem nhóm|xem thêm|see more|view group|tham gia|join)/i
      if (skipPatterns.test(name)) continue

      // Walk up to find container with member count
      const container = link.closest('[role="article"]')
        || link.closest('[data-visualcompletion]')
        || link.parentElement?.parentElement?.parentElement
      const text = container?.textContent || ''

      // Parse member count with K/M and both comma/dot separators
      const memberMatch = text.match(/([\d.,]+)\s*([KkMm])?\s*(thành viên|members|người|member)/i)
      let memberCount = 0
      if (memberMatch) {
        let raw = memberMatch[1].replace(/[,]/g, '') // keep dots for decimals
        const num = parseFloat(raw.replace(/\./g, m => m)) || parseFloat(raw) || 0
        if (memberMatch[2] && /[Kk]/.test(memberMatch[2])) memberCount = Math.round(num * 1000)
        else if (memberMatch[2] && /[Mm]/.test(memberMatch[2])) memberCount = Math.round(num * 1000000)
        else memberCount = parseInt(raw.replace(/\./g, '')) || 0
      }

      results.push({
        fb_group_id: groupId,
        name: name.substring(0, 100),
        url: `https://www.facebook.com/groups/${groupId}`,
        member_count: memberCount,
      })
    }
    return results.slice(0, 30)
  }, [...SYSTEM_PATHS])
}

// ─────────────────────────────────────────────────────────────
// MAIN HANDLER
// ─────────────────────────────────────────────────────────────

async function campaignDiscoverGroups(payload, supabase) {
  const { account_id, campaign_id, role_id, topic, config, feeds_into, parsed_plan } = payload

  const logger = new ActivityLogger(supabase, {
    campaign_id, role_id, account_id,
    job_id: payload.job_id,
    owner_id: payload.owner_id || payload.created_by,
  })

  const { data: account } = await supabase
    .from('accounts')
    .select('*, proxies(*)')
    .eq('id', account_id)
    .single()
  if (!account) throw new Error('Account not found')

  // Check budget
  const budget = account.daily_budget?.join_group || { used: 0, max: 3 }
  const { allowed, remaining } = checkHardLimit('join_group', budget.used, 0)
  if (!allowed || remaining <= 0) {
    throw new Error('SKIP_join_group_budget_exceeded')
  }

  const nickAge = Math.floor((Date.now() - new Date(account.created_at).getTime()) / 86400000)
  const planJoin = getActionParams(parsed_plan, 'join_group', { countMin: 1, countMax: remaining }).count
  const maxJoin = Math.min(applyAgeFactor(remaining, nickAge), planJoin)

  let page
  try {
    const session = await getPage(account)
    page = session.page

    // Verify logged in + warm-up browse
    const currentUrl = page.url()
    if (!currentUrl.includes('facebook.com') || currentUrl.includes('/login') || currentUrl === 'about:blank') {
      console.log(`[CAMPAIGN-SCOUT] Warming up: navigating to FB feed...`)
      await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 30000 })
      await R.sleepRange(3000, 5000)
      const fbUrl = page.url()
      if (fbUrl.includes('/login') || fbUrl.includes('checkpoint')) {
        throw new Error('SKIP_session_not_logged_in')
      }
      // Brief warm-up scroll
      for (let s = 0; s < R.randInt(1, 3); s++) {
        await humanScroll(page)
        await R.sleepRange(2000, 3000)
      }
      console.log(`[CAMPAIGN-SCOUT] Warm-up done`)
    }

    // Use keywords from AI plan params first, then AI expansion fallback
    const planJoinStep = (parsed_plan || []).find(s => s.action === 'join_group')
    let keywords
    if (planJoinStep?.params?.keywords?.length) {
      keywords = planJoinStep.params.keywords
      console.log(`[CAMPAIGN-SCOUT] Using plan keywords: [${keywords.join(', ')}]`)
    } else {
      const { expandSearchKeywords } = require('../../lib/ai-filter')
      keywords = await expandSearchKeywords(topic, payload.mission, payload.owner_id)
    }

    let allGroups = []
    const seenIds = new Set()

    for (const keyword of keywords) {
      // Intercept GraphQL responses during page load
      const graphqlResponses = []
      const responseHandler = async (response) => {
        const url = response.url()
        if (url.includes('/api/graphql') || url.includes('graphql')) {
          try {
            const text = await response.text().catch(() => '')
            if (text && text.length > 100) graphqlResponses.push(text)
          } catch {}
        }
      }
      page.on('response', responseHandler)

      const searchUrl = `https://www.facebook.com/search/groups/?q=${encodeURIComponent(keyword)}`
      console.log(`[CAMPAIGN-SCOUT] Searching groups: "${keyword}"`)
      await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })
      await R.sleepRange(3000, 5000)

      // Scroll to load more results + trigger more GraphQL responses
      const scrollCount = R.randInt(3, 6)
      for (let i = 0; i < scrollCount; i++) {
        await humanScroll(page)
        await R.sleepRange(1500, 2500)
      }

      // Stop intercepting
      page.removeListener('response', responseHandler)

      // Layer 1+2: Extract from GraphQL responses
      let foundGroups = extractGroupsFromResponses(graphqlResponses)
      console.log(`[CAMPAIGN-SCOUT] GraphQL: ${foundGroups.length} groups, ${graphqlResponses.length} responses intercepted`)

      // Layer 3: DOM fallback if GraphQL got nothing
      if (foundGroups.length === 0) {
        foundGroups = await extractGroupsFromDOM(page)
        console.log(`[CAMPAIGN-SCOUT] DOM fallback: ${foundGroups.length} groups`)
      }

      console.log(`[CAMPAIGN-SCOUT] Found ${foundGroups.length} groups for "${keyword}"`)

      // Dedup across keywords
      for (const g of foundGroups) {
        if (!seenIds.has(g.fb_group_id)) {
          seenIds.add(g.fb_group_id)
          allGroups.push(g)
        }
      }

      // Human delay between keyword searches
      if (keywords.indexOf(keyword) < keywords.length - 1) {
        await R.sleepRange(3000, 6000)
      }
    }

    console.log(`[CAMPAIGN-SCOUT] Total unique groups: ${allGroups.length} from ${keywords.length} keyword(s)`)

    if (allGroups.length === 0) {
      await saveDebugScreenshot(page, `campaign-scout-${account_id}`)
      // Save DOM for debugging
      const debugHtml = await page.evaluate(() => document.querySelectorAll('a[href*="/groups/"]').length).catch(() => 0)
      console.log(`[CAMPAIGN-SCOUT] Debug: ${debugHtml} group links in DOM`)
    }

    // Get already joined groups
    const { data: existingGroups } = await supabase
      .from('fb_groups')
      .select('fb_group_id')
      .eq('account_id', account_id)
    const joinedSet = new Set((existingGroups || []).map(g => g.fb_group_id))

    // Filter: not joined, > minMembers (skip minMembers check if member_count unknown)
    const minMembers = config?.min_members || 100
    const notJoined = allGroups.filter(g =>
      !joinedSet.has(g.fb_group_id) && (g.member_count >= minMembers || g.member_count === 0)
    )

    // AI relevance filter
    const candidates = await filterRelevantGroups(notJoined, topic, payload.owner_id, account_id)
    console.log(`[CAMPAIGN-SCOUT] After filter: ${notJoined.length} not joined → ${candidates.length} relevant`)

    let joined = 0
    const joinedGroups = []

    for (const group of candidates) {
      if (joined >= maxJoin) break

      try {
        logger.log('visit_group', { target_type: 'group', target_id: group.fb_group_id, target_name: group.name, target_url: group.url })
        await page.goto(group.url, { waitUntil: 'domcontentloaded', timeout: 30000 })
        await R.sleepRange(2000, 4000)
        await humanMouseMove(page)

        // Find join button — multiple selectors for Vietnamese + English
        const joinBtn = await page.$([
          'div[aria-label="Join group"]',
          'div[aria-label="Tham gia nhóm"]',
          'div[aria-label="Join Group"]',
          'div[role="button"]:has-text("Join group")',
          'div[role="button"]:has-text("Tham gia nhóm")',
          'div[role="button"]:has-text("Join")',
          'div[role="button"]:has-text("Tham gia")',
        ].join(', '))

        if (joinBtn) {
          await humanClick(page, joinBtn)
          await R.sleepRange(1500, 3000)

          // Answer screening questions if any
          const submitBtn = await page.$('div[aria-label="Submit"], div[aria-label="Gửi"]')
          if (submitBtn) {
            await R.sleepRange(1000, 2000)
            await humanClick(page, submitBtn)
            await R.sleepRange(1000, 2000)
          }

          // Increment budget
          await supabase.rpc('increment_budget', {
            p_account_id: account_id,
            p_action_type: 'join_group',
          })

          // Save group to DB with campaign tracking
          await supabase.from('fb_groups').upsert({
            account_id,
            fb_group_id: group.fb_group_id,
            name: group.name,
            url: group.url,
            member_count: group.member_count || 0,
            joined_via_campaign_id: campaign_id || null,
            topic: topic || null,
          }, { onConflict: 'account_id,fb_group_id', ignoreDuplicates: true })

          joined++
          joinedGroups.push(group)
          console.log(`[CAMPAIGN-SCOUT] ✓ Joined: ${group.name} (${group.member_count || '?'} members)`)
          logger.log('join_group', { target_type: 'group', target_id: group.fb_group_id, target_name: group.name, target_url: group.url, details: { member_count: group.member_count } })

          // Gap between joins
          if (joined < maxJoin && candidates.indexOf(group) < candidates.length - 1) {
            const gap = R.joinGroupGap()
            console.log(`[CAMPAIGN-SCOUT] Waiting ${Math.round(gap / 1000)}s before next join`)
            await R.sleep(gap)
          }
        } else {
          console.log(`[CAMPAIGN-SCOUT] No join button for ${group.name} (already joined or private)`)
        }
      } catch (err) {
        console.warn(`[CAMPAIGN-SCOUT] Failed to join ${group.name}: ${err.message}`)
        logger.log('join_group', { target_type: 'group', target_id: group.fb_group_id, target_name: group.name, target_url: group.url, result_status: 'failed', details: { error: err.message } })
      }
    }

    // If feeds_into role, scan members and add to target_queue
    if (feeds_into && joinedGroups.length > 0) {
      let totalMembers = 0
      for (const group of joinedGroups) {
        try {
          await page.goto(`${group.url}/members`, { waitUntil: 'domcontentloaded', timeout: 30000 })
          await R.sleepRange(2000, 3000)

          for (let i = 0; i < 3; i++) {
            await humanScroll(page)
            await R.sleepRange(1000, 2000)
          }

          const members = await page.evaluate(() => {
            const results = []
            const links = document.querySelectorAll('a[href*="/user/"], a[href*="/profile.php"]')
            const seen = new Set()
            for (const link of links) {
              const href = link.href
              const idMatch = href.match(/\/user\/(\d+)/) || href.match(/id=(\d+)/)
              if (!idMatch) continue
              const fbId = idMatch[1]
              if (seen.has(fbId)) continue
              seen.add(fbId)
              results.push({
                fb_user_id: fbId,
                fb_user_name: link.textContent?.trim()?.substring(0, 80) || '',
                fb_profile_url: href,
              })
            }
            return results.slice(0, 30)
          })

          if (members.length > 0) {
            await supabase.from('target_queue').upsert(
              members.map(m => ({
                campaign_id,
                source_role_id: role_id,
                target_role_id: feeds_into,
                fb_user_id: m.fb_user_id,
                fb_user_name: m.fb_user_name,
                fb_profile_url: m.fb_profile_url,
                source_group_name: group.name,
                active_score: 50 + Math.random() * 50,
                status: 'pending',
              })),
              { onConflict: 'campaign_id,fb_user_id', ignoreDuplicates: true }
            )
            totalMembers += members.length
            logger.log('scan', { target_type: 'group', target_id: group.fb_group_id, target_name: group.name, details: { members_found: members.length } })
          }
        } catch (err) {
          console.warn(`[CAMPAIGN-SCOUT] Failed to scan members of ${group.name}: ${err.message}`)
        }
      }
      console.log(`[CAMPAIGN-SCOUT] Added ${totalMembers} members to target_queue`)
    }

    return {
      success: true,
      groups_found: allGroups.length,
      groups_joined: joined,
      topic,
    }
  } catch (err) {
    if (page) await saveDebugScreenshot(page, `campaign-scout-${account_id}`)
    throw err
  } finally {
    await logger.flush().catch(() => {})
    // DON'T navigate to about:blank — keep page on FB for session reuse
    releaseSession(account_id)
  }
}

module.exports = campaignDiscoverGroups
