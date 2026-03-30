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
const { filterRelevantGroups, evaluateGroup, extractGroupInfo } = require('../../lib/ai-filter')
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

    // Get groups ACTUALLY joined by campaign (not auto-fetched bulk data)
    // Only exclude groups that were joined via a campaign (have joined_via_campaign_id)
    const { data: campaignJoined } = await supabase
      .from('fb_groups')
      .select('fb_group_id')
      .eq('account_id', account_id)
      .not('joined_via_campaign_id', 'is', null)
    const joinedSet = new Set((campaignJoined || []).map(g => g.fb_group_id))

    // Check which groups nick is already a member of (in fb_groups table)
    const { data: existingGroups } = await supabase
      .from('fb_groups')
      .select('fb_group_id, joined_via_campaign_id, ai_relevance')
      .eq('account_id', account_id)
    const existingMap = new Map((existingGroups || []).map(g => [g.fb_group_id, g]))

    // Separate: new groups to join vs already-member groups to tag
    const toJoin = []       // not in fb_groups → need to join
    const toTag = []        // already member but not tagged for this campaign → just tag
    const alreadyTagged = [] // already tagged for a campaign → skip

    for (const g of allGroups) {
      const existing = existingMap.get(g.fb_group_id)
      if (existing) g.ai_relevance = existing.ai_relevance // propagate cache
      if (!existing) {
        toJoin.push(g)
      } else if (!existing.joined_via_campaign_id) {
        toTag.push(g)  // member but no campaign tag → can claim for this campaign
      } else {
        alreadyTagged.push(g)
      }
    }
    console.log(`[CAMPAIGN-SCOUT] Total: ${allGroups.length}, to-join: ${toJoin.length}, to-tag: ${toTag.length}, already-tagged: ${alreadyTagged.length}`)

    // AI relevance filter on BOTH toJoin + toTag (all potential candidates)
    const allCandidates = [...toJoin, ...toTag]
    const relevant = allCandidates.length > 0
      ? await filterRelevantGroups(allCandidates, topic, payload.owner_id, account_id, supabase)
      : []
    console.log(`[CAMPAIGN-SCOUT] After AI filter: ${allCandidates.length} → ${relevant.length} relevant`)

    // Step 1: Tag already-member groups for this campaign (no browser action needed)
    const relevantIds = new Set(relevant.map(g => g.fb_group_id))
    let tagged = 0
    for (const g of toTag) {
      if (!relevantIds.has(g.fb_group_id)) continue
      await supabase.from('fb_groups')
        .update({ joined_via_campaign_id: campaign_id, topic: topic })
        .eq('account_id', account_id)
        .eq('fb_group_id', g.fb_group_id)
      tagged++
      logger.log('visit_group', { target_type: 'group', target_id: g.fb_group_id, target_name: g.name, target_url: g.url, details: { action: 'tagged_existing', campaign_id } })
      console.log(`[CAMPAIGN-SCOUT] ✓ Tagged existing: ${g.name}`)
    }
    if (tagged > 0) console.log(`[CAMPAIGN-SCOUT] Tagged ${tagged} existing groups for campaign`)

    // Step 2: Join NEW groups (need browser action)
    let joined = 0
    const joinedGroups = []
    const relevantToJoin = relevant.filter(g => toJoin.some(tj => tj.fb_group_id === g.fb_group_id))

    let visited = 0
    const maxVisit = maxJoin * 3 // Visit at most 3x the join target (avoid visiting 34 groups for 3 joins)

    for (const group of relevantToJoin) {
      if (joined >= maxJoin) break
      if (visited >= maxVisit) {
        console.log(`[CAMPAIGN-SCOUT] Visited ${visited} groups, joined ${joined}/${maxJoin} — stopping to save time`)
        break
      }
      // Skip groups already evaluated as irrelevant for this topic (cached)
      const topicKey_ = topic.toLowerCase().trim().replace(/\s+/g, '_').slice(0, 50)
      const cachedEval = group.ai_relevance?.[topicKey_]
      if (cachedEval && !cachedEval.relevant && cachedEval.evaluated_at) {
        const ageMs = Date.now() - new Date(cachedEval.evaluated_at).getTime()
        if (ageMs < 7 * 24 * 3600 * 1000) { // Cache valid 7 days
          console.log(`[CAMPAIGN-SCOUT] ⏭️ Cache skip "${group.name}" (score: ${cachedEval.score}, cached ${Math.round(ageMs / 3600000)}h ago)`)
          continue
        }
      }

      visited++

      try {
        logger.log('visit_group', { target_type: 'group', target_id: group.fb_group_id, target_name: group.name, target_url: group.url })
        await page.goto(group.url, { waitUntil: 'domcontentloaded', timeout: 30000 })
        await R.sleepRange(2000, 4000)
        await humanMouseMove(page)

        // Extract group info from page: name, desc, 2-3 posts, language
        const groupInfo = await extractGroupInfo(page).catch(() => ({
          name: group.name, description: '', posts: [], language: '?', member_count: group.member_count
        }))
        groupInfo.name = groupInfo.name || group.name
        groupInfo.member_count = groupInfo.member_count || group.member_count

        // AI per-group evaluation: name + desc + posts → join or skip?
        const evaluation = await evaluateGroup(groupInfo, topic, payload.owner_id)

        // Cache AI eval result to DB (both accept and reject)
        const topicKey = topic.toLowerCase().trim().replace(/\s+/g, '_').slice(0, 50)
        const existingRelevance = group.ai_relevance || {}
        existingRelevance[topicKey] = {
          relevant: evaluation.relevant,
          score: evaluation.score,
          reason: (evaluation.reason || '').slice(0, 200),
          lang: evaluation.language,
          evaluated_at: new Date().toISOString(),
        }
        // Async save — don't block
        supabase.from('fb_groups').update({ ai_relevance: existingRelevance })
          .eq('fb_group_id', group.fb_group_id).eq('account_id', account_id)
          .then(() => {}).catch(() => {})

        // Language filter: only join groups matching campaign language preference
        const allowedLangs = config?.allowed_languages || ['vi'] // default: Vietnamese only
        if (evaluation.language && !allowedLangs.includes(evaluation.language) && evaluation.language !== '?') {
          console.log(`[CAMPAIGN-SCOUT] 🌐 Skip "${group.name}" — wrong language: ${evaluation.language} (allowed: ${allowedLangs.join(',')})`)
          logger.log('visit_group', {
            target_type: 'group', target_name: group.name, result_status: 'skipped',
            details: { reason: `Language ${evaluation.language} not in allowed: ${allowedLangs}`, language: evaluation.language, ai_decision: 'lang_reject' }
          })
          continue
        }

        if (!evaluation.relevant) {
          console.log(`[CAMPAIGN-SCOUT] ❌ Skip "${group.name}" — ${evaluation.reason} (score: ${evaluation.score}, lang: ${evaluation.language})`)
          logger.log('visit_group', {
            target_type: 'group', target_name: group.name, result_status: 'skipped',
            details: { reason: evaluation.reason, score: evaluation.score, language: evaluation.language, ai_decision: 'reject' }
          })
          continue
        }
        console.log(`[CAMPAIGN-SCOUT] ✅ "${group.name}" — ${evaluation.reason} (score: ${evaluation.score}, lang: ${evaluation.language})`)

        // Find join button — try aria-label first, then text match via locator
        let joinBtn = await page.$('div[aria-label="Join group"], div[aria-label="Tham gia nhóm"], div[aria-label="Join Group"], div[aria-label="Tham gia"]')
        if (!joinBtn) {
          // Fallback: Playwright locator with text matching
          try {
            const loc = page.locator('div[role="button"]:has-text("Tham gia"), div[role="button"]:has-text("Join")').first()
            if (await loc.isVisible({ timeout: 2000 })) joinBtn = await loc.elementHandle()
          } catch {}
        }

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
          if (joined < maxJoin && relevantToJoin.indexOf(group) < relevantToJoin.length - 1) {
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
      groups_tagged: tagged,
      groups_relevant: relevant.length,
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
