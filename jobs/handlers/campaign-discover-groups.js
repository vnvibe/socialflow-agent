/**
 * Campaign Handler: Discover Groups (Role: scout)
 * Search groups by topic, join, scan members → feed target_queue
 * Uses 3-layer extraction: GraphQL interception → Regex fallback → DOM links
 */

const { getPage, releaseSession } = require('../../browser/session-pool')
const { delay, humanScroll, humanMouseMove, humanClick } = require('../../browser/human')
const { saveDebugScreenshot } = require('./post-utils')
const { checkHardLimit, applyAgeFactor, getNickAgeDays } = require('../../lib/hard-limits')
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

  const nickAge = getNickAgeDays(account)
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

    // Get groups ALREADY joined by ANY nick in this campaign (cross-nick dedup)
    // Không cần 2 nicks cùng join 1 group — 1 nick đủ rồi
    const { data: campaignJoined } = await supabase
      .from('fb_groups')
      .select('fb_group_id')
      .eq('joined_via_campaign_id', campaign_id)
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

      // Cross-nick dedup: skip if ANY nick in campaign already joined this group
      if (joinedSet.has(g.fb_group_id)) {
        alreadyTagged.push(g)
      } else if (!existing) {
        toJoin.push(g)
      } else if (!existing.joined_via_campaign_id) {
        toTag.push(g)  // member but no campaign tag → can claim for this campaign
      } else {
        alreadyTagged.push(g)
      }
    }
    console.log(`[CAMPAIGN-SCOUT] Total: ${allGroups.length}, to-join: ${toJoin.length}, to-tag: ${toTag.length}, already-tagged: ${alreadyTagged.length}`)

    // AI relevance filter on BOTH toJoin + toTag (all potential candidates from search)
    const allCandidates = [...toJoin, ...toTag]
    const relevant = allCandidates.length > 0
      ? await filterRelevantGroups(allCandidates, topic, payload.owner_id, account_id, supabase)
      : []
    console.log(`[CAMPAIGN-SCOUT] After AI filter: ${allCandidates.length} → ${relevant.length} relevant`)

    // ── Step 0: SCAN UNTAGGED EXISTING GROUPS (518 groups user already joined) ──
    // Mỗi lần scout, AI đánh giá batch group chưa gán nhãn → gán nhãn nếu liên quan
    // Giới hạn 20 group/lần để không tốn quá nhiều API calls
    const { data: untaggedGroups } = await supabase.from('fb_groups')
      .select('id, fb_group_id, name, url, member_count, ai_relevance')
      .eq('account_id', account_id)
      .is('joined_via_campaign_id', null)
      .or('tags.is.null,tags.eq.{}')
      .limit(20)

    if (untaggedGroups?.length > 0) {
      // Filter: chỉ đánh giá group chưa có AI cache cho topic này
      const topicKey = topic.toLowerCase().trim().replace(/\s+/g, '_').slice(0, 50)
      const needsEval = untaggedGroups.filter(g => {
        const cached = g.ai_relevance?.[topicKey]
        if (!cached) return true
        // Re-eval nếu cache > 7 ngày
        const age = cached.evaluated_at ? Date.now() - new Date(cached.evaluated_at).getTime() : Infinity
        return age > 7 * 24 * 3600 * 1000
      })

      if (needsEval.length > 0) {
        console.log(`[CAMPAIGN-SCOUT] 🔍 Scanning ${needsEval.length} untagged existing groups for topic "${topic}"`)
        try {
          const evalResult = await filterRelevantGroups(needsEval, topic, payload.owner_id, account_id, supabase)
          const evalRelevantIds = new Set(evalResult.map(g => g.fb_group_id))

          let autoTagged = 0
          const newTags = (topic || '').split(/[,;]+/).map(t => t.trim().toLowerCase()).filter(t => t.length > 1)

          for (const g of needsEval) {
            if (evalRelevantIds.has(g.fb_group_id)) {
              // Group liên quan → gán nhãn cho campaign
              await supabase.from('fb_groups').update({
                joined_via_campaign_id: campaign_id, topic, tags: newTags,
              }).eq('account_id', account_id).eq('fb_group_id', g.fb_group_id)
              try { await supabase.rpc('append_campaign_to_group', {
                p_account_id: account_id, p_fb_group_id: g.fb_group_id, p_campaign_id: campaign_id,
              }) } catch {}
              autoTagged++
              console.log(`[CAMPAIGN-SCOUT] ✓ Auto-tagged existing: ${g.name}`)
            }
          }
          if (autoTagged > 0) {
            console.log(`[CAMPAIGN-SCOUT] 🏷️ Auto-tagged ${autoTagged}/${needsEval.length} existing groups`)
            logger.log('ai_filter', {
              target_type: 'group', target_name: topic,
              details: { action: 'auto_tag_existing', scanned: needsEval.length, tagged: autoTagged },
            })
          }
        } catch (err) {
          console.warn(`[CAMPAIGN-SCOUT] Auto-tag scan failed: ${err.message}`)
        }
      }
    }

    // Step 1: Tag already-member groups from SEARCH results
    const relevantIds = new Set(relevant.map(g => g.fb_group_id))
    let tagged = 0
    for (const g of toTag) {
      if (!relevantIds.has(g.fb_group_id)) continue
      const newTags = (topic || '').split(/[,;]+/).map(t => t.trim().toLowerCase()).filter(t => t.length > 1)
      await supabase.from('fb_groups')
        .update({ joined_via_campaign_id: campaign_id, topic: topic, tags: newTags })
        .eq('account_id', account_id)
        .eq('fb_group_id', g.fb_group_id)
      try { await supabase.rpc('append_campaign_to_group', {
        p_account_id: account_id, p_fb_group_id: g.fb_group_id, p_campaign_id: campaign_id,
      }) } catch {}
      tagged++
      logger.log('visit_group', { target_type: 'group', target_id: g.fb_group_id, target_name: g.name, target_url: g.url, details: { action: 'tagged_existing', campaign_id } })
      console.log(`[CAMPAIGN-SCOUT] ✓ Tagged from search: ${g.name}`)
    }
    if (tagged > 0) console.log(`[CAMPAIGN-SCOUT] Tagged ${tagged} groups from search results`)

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
      // Blacklist check: skip groups with skip_until in the future
      if (group.skip_until && new Date(group.skip_until) > new Date()) {
        console.log(`[CAMPAIGN-SCOUT] ⏭️ Blacklisted "${group.name}" until ${new Date(group.skip_until).toLocaleDateString()}`)
        continue
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

        // ═══ AI GROUP EVALUATION: crawl info + AI decides join or skip ═══
        // AI fail = skip THIS group THIS run (NOT failure, will retry next run)
        let evaluation = null
        try {
          evaluation = await evaluateGroup(groupInfo, topic, payload.owner_id)
        } catch (aiErr) {
          // AI unavailable — skip group this run, will retry next time
          console.log(`[CAMPAIGN-SCOUT] ⚠️ AI eval failed for "${group.name}": ${aiErr.message} — skip this run, retry later`)
          logger.log('visit_group', {
            target_type: 'group', target_name: group.name, result_status: 'skipped',
            details: { reason: 'ai_eval_failed', error: aiErr.message },
          })
          continue // NOT a failure, just skip
        }

        // Cache AI eval result to DB (both accept and reject)
        const topicKey = topic.toLowerCase().trim().replace(/\s+/g, '_').slice(0, 50)
        const existingRelevance = group.ai_relevance || {}
        const tier = evaluation.tier || (evaluation.score >= 8 ? 'tier1_potential' : evaluation.score >= 5 ? 'tier2_prospect' : 'tier3_irrelevant')
        existingRelevance[topicKey] = {
          relevant: evaluation.relevant,
          score: evaluation.score,
          tier,
          reason: (evaluation.reason || '').slice(0, 200),
          note: (evaluation.note || '').slice(0, 300),
          sample_topics: evaluation.sample_topics || [],
          lang: evaluation.language,
          evaluated_at: new Date().toISOString(),
        }
        // Save cache + ai_note for user review
        supabase.from('fb_groups').update({
          ai_relevance: existingRelevance,
          ai_note: (evaluation.note || evaluation.reason || '').slice(0, 300),
        }).eq('fb_group_id', group.fb_group_id).eq('account_id', account_id)

        // Language filter: skip non-VN — BUT override if group name contains topic keyword
        // "OpenClaw VN" có thể bị AI đánh là tiếng Anh vì tên tiếng Anh → sai
        const allowedLangs = config?.allowed_languages || ['vi']
        const topicKws = topic.toLowerCase().split(/[\s,]+/).filter(k => k.length > 2)
        const nameContainsTopic = topicKws.some(kw => (group.name || '').toLowerCase().includes(kw))

        if (evaluation.language && !allowedLangs.includes(evaluation.language) && evaluation.language !== '?') {
          if (nameContainsTopic) {
            // Tên group chứa topic keyword → OVERRIDE language rejection
            console.log(`[CAMPAIGN-SCOUT] 🌐 "${group.name}" lang=${evaluation.language} BUT name matches topic → OVERRIDE, keeping`)
          } else if (evaluation.score >= 7) {
            // AI score cao → có thể vẫn hữu ích dù khác ngôn ngữ
            console.log(`[CAMPAIGN-SCOUT] 🌐 "${group.name}" lang=${evaluation.language} BUT score=${evaluation.score} high → OVERRIDE, keeping`)
          } else {
            console.log(`[CAMPAIGN-SCOUT] 🌐 Skip "${group.name}" — lang: ${evaluation.language} (allowed: ${allowedLangs.join(',')})`)
            logger.log('visit_group', {
              target_type: 'group', target_name: group.name, result_status: 'skipped',
              details: { reason: `lang_${evaluation.language}`, language: evaluation.language },
            })
            continue
          }
        }

        // Save ai_join_score + risk_level to fb_groups for future reference
        try {
          await supabase.from('fb_groups').update({
            ai_join_score: evaluation.score,
            ai_risk_level: evaluation.risk_level || null,
          }).eq('fb_group_id', group.fb_group_id).eq('account_id', account_id)
        } catch {}

        // GATE 1: High risk → skip + blacklist 30 days
        if (evaluation.risk_level === 'high') {
          console.log(`[CAMPAIGN-SCOUT] ⛔ Skip "${group.name}" — HIGH RISK (spam/unsafe), blacklisted 30 days`)
          try {
            await supabase.from('fb_groups').update({
              skip_until: new Date(Date.now() + 30 * 86400000).toISOString(),
            }).eq('fb_group_id', group.fb_group_id).eq('account_id', account_id)
          } catch {}
          logger.log('visit_group', {
            target_type: 'group', target_name: group.name, result_status: 'skipped',
            details: { reason: 'high_risk', risk_level: 'high', score: evaluation.score },
          })
          continue
        }

        if (!evaluation.relevant) {
          // OVERRIDE: nếu tên group chứa topic keyword → approve dù AI reject
          if (nameContainsTopic) {
            console.log(`[CAMPAIGN-SCOUT] ⚠️ AI rejected "${group.name}" BUT name matches topic → OVERRIDE, keeping`)
            evaluation.relevant = true
            evaluation.score = Math.max(evaluation.score, 6)
            evaluation.reason = `name_match_override: ${evaluation.reason}`
          } else {
            console.log(`[CAMPAIGN-SCOUT] ❌ Skip "${group.name}" — ${evaluation.reason} (score: ${evaluation.score})`)
            // Blacklist low-score groups for 30 days
            if (evaluation.score < 4) {
              try {
                await supabase.from('fb_groups').update({
                  skip_until: new Date(Date.now() + 30 * 86400000).toISOString(),
                }).eq('fb_group_id', group.fb_group_id).eq('account_id', account_id)
              } catch {}
            }
            logger.log('visit_group', {
              target_type: 'group', target_name: group.name, result_status: 'skipped',
              details: { reason: evaluation.reason, score: evaluation.score, ai_decision: 'reject', risk_level: evaluation.risk_level },
            })
            continue
          }
        }

        // GATE 2: Borderline groups (score 5-6) — only for warm nicks (>60 days)
        const nickAge = getNickAgeDays(account)
        if (evaluation.score >= 5 && evaluation.score <= 6 && nickAge < 60) {
          console.log(`[CAMPAIGN-SCOUT] ⏭️ Borderline "${group.name}" (score: ${evaluation.score}) — nick too young (${nickAge}d < 60d), skipping`)
          logger.log('visit_group', {
            target_type: 'group', target_name: group.name, result_status: 'skipped',
            details: { reason: 'borderline_nick_young', score: evaluation.score, nick_age: nickAge },
          })
          continue
        }

        console.log(`[CAMPAIGN-SCOUT] ✅ "${group.name}" — ${evaluation.reason} (score: ${evaluation.score}, risk: ${evaluation.risk_level || 'low'})`)

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

          // Detect "pending review" state (admin approval required)
          try {
            await R.sleepRange(500, 1000)
            const pageText = await page.evaluate(() => document.body?.innerText?.substring(0, 500) || '')
            const isPending = /pending|chờ duyệt|chờ phê duyệt|waiting.*approval|awaiting/i.test(pageText)
            if (isPending) {
              // Track consecutive pendings per nick for this job
              if (!campaignDiscoverGroups._pendingCount) campaignDiscoverGroups._pendingCount = {}
              const key = account_id
              campaignDiscoverGroups._pendingCount[key] = (campaignDiscoverGroups._pendingCount[key] || 0) + 1
              const { checkPendingLoop } = require('../../lib/signal-collector')
              checkPendingLoop(account_id, payload.job_id, group.fb_group_id, campaignDiscoverGroups._pendingCount[key])
            }
          } catch {}

          // Increment budget
          await supabase.rpc('increment_budget', {
            p_account_id: account_id,
            p_action_type: 'join_group',
          })

          // Save group to DB with campaign tracking + tags
          const groupTags = (topic || '').split(/[,;]+/).map(t => t.trim().toLowerCase()).filter(t => t.length > 1)
          await supabase.from('fb_groups').upsert({
            account_id,
            fb_group_id: group.fb_group_id,
            name: group.name,
            url: group.url,
            member_count: group.member_count || 0,
            joined_via_campaign_id: campaign_id || null,
            topic: topic || null,
            tags: groupTags,
          }, { onConflict: 'account_id,fb_group_id' })

          // Append to campaign_ids array (multi-campaign support)
          if (campaign_id) {
            try { await supabase.rpc('append_campaign_to_group', {
              p_account_id: account_id, p_fb_group_id: group.fb_group_id, p_campaign_id: campaign_id,
            }) } catch {}
          }

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

    // NOTE: Member scraping removed (2026-04-04)
    // Scout's job is ONLY to find + join + label groups.
    // Connect role handles finding active people by scanning posts in labeled groups.

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
    await releaseSession(account_id, supabase)
  }
}

module.exports = campaignDiscoverGroups
