/**
 * Campaign Handler: Nurture Group (Role: nurture)
 * Visit joined groups, like posts, leave natural comments
 * Uses desktop Facebook with JS-based interaction (bypasses overlay interception)
 * Comments use mobile Facebook URL per-post (proven in comment-post.js)
 */

const { getPage, releaseSession } = require('../../browser/session-pool')
const { delay, humanScroll, humanMouseMove } = require('../../browser/human')
const { checkAccountStatus, saveDebugScreenshot } = require('./post-utils')
const { checkHardLimit, SessionTracker, applyAgeFactor, getNickAgeDays } = require('../../lib/hard-limits')
const R = require('../../lib/randomizer')
const { getActionParams } = require('../../lib/plan-executor')
const { generateComment, generateOpportunityComment } = require('../../lib/ai-comment')
const { evaluatePosts, qualityGateComment, generateSmartComment, evaluateLeadQuality, scanGroupPosts, getBestPosts, detectGroupLanguage } = require('../../lib/ai-brain')
const { getSelectors, toMobileUrl, COMMENT_INPUT_SELECTORS, COMMENT_SUBMIT_SELECTORS, COMMENT_LINK_SELECTORS } = require('../../lib/mobile-selectors')
const { ActivityLogger } = require('../../lib/activity-logger')

// Group visit rate limit — max 2 nicks per group per 30 min (module-level cache)
const groupVisitCache = new Map() // groupFbId → [{accountId, timestamp}]
const GROUP_VISIT_WINDOW = 30 * 60 * 1000 // 30 min

// === Group performance tracking helpers ===
async function recordGroupSkip(supabase, accountId, fbGroupId) {
  if (!supabase || !fbGroupId) return
  try {
    // Increment consecutive_skips, fetch new value
    const { data: cur } = await supabase.from('fb_groups')
      .select('consecutive_skips')
      .eq('account_id', accountId).eq('fb_group_id', fbGroupId).single()
    const next = (cur?.consecutive_skips || 0) + 1
    await supabase.from('fb_groups')
      .update({ consecutive_skips: next })
      .eq('account_id', accountId).eq('fb_group_id', fbGroupId)
  } catch {}
}

async function recordGroupYield(supabase, accountId, fbGroupId, eligibleCount) {
  if (!supabase || !fbGroupId) return
  try {
    const { data: cur } = await supabase.from('fb_groups')
      .select('total_yields')
      .eq('account_id', accountId).eq('fb_group_id', fbGroupId).single()
    await supabase.from('fb_groups')
      .update({
        consecutive_skips: 0, // reset
        last_yield_at: new Date().toISOString(),
        total_yields: (cur?.total_yields || 0) + eligibleCount,
      })
      .eq('account_id', accountId).eq('fb_group_id', fbGroupId)
  } catch {}
}
const GROUP_VISIT_MAX = 2

function canVisitGroup(groupFbId, accountId) {
  const now = Date.now()
  const visits = (groupVisitCache.get(groupFbId) || []).filter(v => now - v.timestamp < GROUP_VISIT_WINDOW)
  groupVisitCache.set(groupFbId, visits)
  // Own visit doesn't count against limit
  const otherVisits = visits.filter(v => v.accountId !== accountId)
  return otherVisits.length < GROUP_VISIT_MAX
}

function recordGroupVisit(groupFbId, accountId) {
  const visits = groupVisitCache.get(groupFbId) || []
  visits.push({ accountId, timestamp: Date.now() })
  groupVisitCache.set(groupFbId, visits)
}

async function campaignNurture(payload, supabase) {
  const { account_id, campaign_id, role_id, topic: rawTopic, config, read_from, parsed_plan } = payload
  const startTime = Date.now()

  // Build full topic from: plan keywords + topic field + requirement
  // This ensures AI filter + keyword fallback use ALL relevant terms
  const planKeywords = (Array.isArray(parsed_plan) ? parsed_plan : [])
    .flatMap(s => s.params?.keywords || [])
    .filter(Boolean)
  const topicParts = [rawTopic, ...planKeywords].filter(Boolean)
  const topic = [...new Set(topicParts.map(t => t.trim().toLowerCase()))].join(', ') || rawTopic

  // Activity logger — logs every action for AI analysis
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

  const likeBudget = account.daily_budget?.like || { used: 0, max: 80 }
  const commentBudget = account.daily_budget?.comment || { used: 0, max: 25 }

  const tracker = new SessionTracker()
  const nickAge = getNickAgeDays(account)

  const likeCheck = checkHardLimit('like', likeBudget.used, 0)
  const commentCheck = checkHardLimit('comment', commentBudget.used, 0)

  // ── Ad config: load brand settings for opportunity comments ──
  // Brand config: prefer top-level brand_config (from new SaaS form),
  // fall back to legacy config.advertising shape
  const brandConfig = payload.brand_config || config?.brand_config || config?.advertising || null
  const adEnabled = brandConfig && (payload.ad_mode === 'ad_enabled' || config?.ad_mode === 'ad_enabled' || brandConfig.brand_name)
  const canDoAdComment = adEnabled && nickAge >= 30 // warmup >= 30 days required

  // Count today's ad comments for this nick (max 2/day)
  let adCommentsToday = 0
  if (canDoAdComment) {
    try {
      const vnToday = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10)
      const { count } = await supabase
        .from('campaign_activity_log')
        .select('id', { count: 'exact', head: true })
        .eq('account_id', account_id)
        .eq('action_type', 'opportunity_comment')
        .gte('created_at', vnToday + 'T00:00:00+07:00')
      adCommentsToday = count || 0
    } catch {}
  }
  const AD_COMMENT_DAILY_LIMIT = 2

  // Apply age factor for newer accounts
  const maxLikesSession = applyAgeFactor(likeCheck.remaining, nickAge)
  const maxCommentsSession = applyAgeFactor(commentCheck.remaining, nickAge)

  if (!likeCheck.allowed && !commentCheck.allowed) {
    throw new Error('SKIP_nurture_budget_exceeded')
  }

  // Get groups — from target_queue (workflow chaining) or account's joined groups
  let groups = []
  if (read_from) {
    const { data: queueEntries } = await supabase
      .from('target_queue')
      .select('*')
      .eq('campaign_id', campaign_id)
      .eq('target_role_id', role_id)
      .eq('status', 'pending')
      .order('active_score', { ascending: false })
      .limit(5)

    if (queueEntries?.length) {
      const seen = new Set()
      for (const entry of queueEntries) {
        if (entry.source_group_name && !seen.has(entry.source_group_name)) {
          seen.add(entry.source_group_name)
          const { data: grp } = await supabase
            .from('fb_groups')
            .select('fb_group_id, name, url')
            .eq('account_id', account_id)
            .ilike('name', `%${entry.source_group_name}%`)
            .limit(1)
            .single()
          if (grp) groups.push(grp)
        }
      }
      if (groups.length > 0) {
        const ids = queueEntries.map(e => e.id)
        await supabase.from('target_queue').update({ status: 'done', processed_at: new Date() }).in('id', ids)
      }
      console.log(`[NURTURE] Got ${groups.length} groups from workflow queue`)
    }
  }

  if (!groups.length) {
    // ── CHỈ dùng group ĐÃ GÁN NHÃN (tag/campaign/topic) ──
    // Group không gán nhãn = không liên quan → KHÔNG dùng, KHÔNG fallback
    const { data: labeledGroups } = await supabase.from('fb_groups')
      .select('id, fb_group_id, name, url, member_count, topic, tags, joined_via_campaign_id, ai_relevance, user_approved, consecutive_skips, last_yield_at, total_yields, language')
      .eq('account_id', account_id)
      .or('is_blocked.is.null,is_blocked.eq.false')
      .or('user_approved.is.null,user_approved.eq.true') // Skip groups user rejected (false), keep null + true

    const allLabeled = (labeledGroups || []).filter(g => {
      // Group phải có ÍT NHẤT 1 trong: tags, topic, campaign_id
      const hasTags = g.tags?.length > 0
      const hasTopic = g.topic && g.topic.trim().length > 0
      const hasCampaign = g.joined_via_campaign_id
      return hasTags || hasTopic || hasCampaign
    })

    if (!allLabeled.length) {
      console.log(`[NURTURE] Không có group nào được gán nhãn — cần scout trước`)
    } else if (!topic) {
      groups = allLabeled
      console.log(`[NURTURE] Dùng ${groups.length} groups đã gán nhãn (không có topic filter)`)
    } else {
      const topicLower = topic.toLowerCase()
      const topicKeywords = topicLower.split(/[\s,]+/).filter(k => k.length > 2)

      // Filter: chỉ group match topic qua tags/topic field/campaign
      groups = allLabeled.filter(g => {
        // Match qua tags
        if (g.tags?.some(tag => topicKeywords.some(kw => tag.toLowerCase().includes(kw) || kw.includes(tag.toLowerCase())))) return true
        // Match qua topic field
        if (g.topic) {
          const gt = g.topic.toLowerCase()
          if (gt.includes(topicLower) || topicLower.includes(gt) || topicKeywords.some(kw => gt.includes(kw))) return true
        }
        // Match qua campaign
        if (g.joined_via_campaign_id === campaign_id) return true
        // AI cache approved
        const topicKey = topicLower.trim().replace(/\s+/g, '_').slice(0, 50)
        const cached = g.ai_relevance?.[topicKey]
        if (cached?.relevant && cached.score >= 5) return true
        return false
      })

      console.log(`[NURTURE] ${groups.length}/${allLabeled.length} groups gán nhãn match topic "${topic}"`)
    }

    // ── SMART ROTATION: ưu tiên group có score cao + recent yield ──
    // Score-based sort: tier1 (>=8) → tier2 (5-7) → tier3 (<5)
    // Penalty: groups with consecutive_skips >= 2 đẩy xuống cuối
    if (groups.length > 1) {
      const topicKey = (topic || '').toLowerCase().trim().replace(/\s+/g, '_').slice(0, 50)

      const scoreOf = (g) => {
        const cached = g.ai_relevance?.[topicKey]
        return cached?.score || 5
      }

      // Get recent visits to deprioritize same-group repeats within session
      const { data: recentVisits } = await supabase
        .from('campaign_activity_log')
        .select('target_name')
        .eq('campaign_id', campaign_id)
        .eq('action_type', 'visit_group')
        .eq('account_id', account_id)
        .order('created_at', { ascending: false })
        .limit(groups.length)
      const recentNames = (recentVisits || []).map(v => v.target_name)

      groups.sort((a, b) => {
        // 1. Penalize consecutive skips heavily — push to bottom
        const skipsA = a.consecutive_skips || 0
        const skipsB = b.consecutive_skips || 0
        if (skipsA >= 2 && skipsB < 2) return 1
        if (skipsB >= 2 && skipsA < 2) return -1

        // 2. Sort by AI relevance score (higher first)
        const sa = scoreOf(a)
        const sb = scoreOf(b)
        if (sa !== sb) return sb - sa

        // 3. Tiebreaker: prefer groups not visited recently
        const aRecent = recentNames.indexOf(a.name)
        const bRecent = recentNames.indexOf(b.name)
        if (aRecent === -1 && bRecent !== -1) return -1
        if (bRecent === -1 && aRecent !== -1) return 1

        // 4. Final tiebreaker: random
        return Math.random() - 0.5
      })

      console.log(`[NURTURE] Smart rotation: ${groups.slice(0, 5).map(g => `${g.name?.substring(0, 20)}(s:${scoreOf(g)},sk:${g.consecutive_skips || 0})`).join(' → ')}`)
    }
  }

  // No groups → run scout inline if plan has join_group step
  if (!groups?.length && parsed_plan?.some(s => s.action === 'join_group')) {
    console.log(`[NURTURE] No groups joined — running inline scout for topic: ${topic}`)
    try {
      const discoverHandler = require('./campaign-discover-groups')
      const scoutResult = await discoverHandler(payload, supabase)
      console.log(`[NURTURE] Scout done: joined ${scoutResult.groups_joined} groups`)

      // Re-fetch + re-filter after scout
      const { data: newGroups } = await supabase
        .from('fb_groups')
        .select('id, fb_group_id, name, url, member_count, ai_relevance')
        .eq('account_id', account_id)

      if (topic && newGroups?.length) {
        try {
          const { filterRelevantGroups } = require('../../lib/ai-filter')
          groups = await filterRelevantGroups(newGroups, topic, payload.owner_id, account_id, supabase)
          console.log(`[NURTURE] Post-scout AI filtered: ${groups.length}/${newGroups.length}`)
        } catch {
          groups = newGroups || []
        }
      } else {
        groups = newGroups || []
      }
    } catch (err) {
      console.warn(`[NURTURE] Inline scout failed: ${err.message}`)
    }
  }

  if (!groups?.length) throw new Error('SKIP_no_groups_joined')

  const shuffled = groups.sort(() => Math.random() - 0.5)
  const groupsToVisit = shuffled.slice(0, R.randInt(1, Math.min(3, groups.length)))

  let page
  try {
    const session = await getPage(account)
    page = session.page

    // ─── Warm-up: browse feed naturally before doing actions ───
    const currentUrl = page.url()
    const needsWarmup = !currentUrl.includes('facebook.com') || currentUrl.includes('about:blank')
    if (needsWarmup) {
      console.log(`[NURTURE] Warming up nick: browsing feed...`)
      logger.log('visit_group', { target_type: 'feed', target_name: 'Warm-up browse', details: { phase: 'warmup' } })
      try {
        await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 30000 })
        await R.sleepRange(3000, 6000)
        // Scroll feed naturally
        for (let s = 0; s < R.randInt(2, 4); s++) {
          await humanScroll(page)
          await R.sleepRange(2000, 4000)
        }
        await humanMouseMove(page)
        console.log(`[NURTURE] Warm-up done, starting campaign work`)
      } catch (err) {
        console.warn(`[NURTURE] Warm-up failed: ${err.message}`)
      }
    }

    let totalLikes = 0
    let totalComments = 0
    const groupResults = []
    let aiGroupEvalsThisRun = 0
    const MAX_AI_GROUP_EVALS = 2

    // === RANDOMIZE TASK ORDER per nick (avoid pattern detection) ===
    // 50% chance: scan first then comment | 50% comment from existing scans then scan new
    const scanFirst = Math.random() < 0.5
    if (scanFirst) {
      console.log(`[NURTURE] Strategy: SCAN first → then COMMENT from scored posts`)
    } else {
      console.log(`[NURTURE] Strategy: COMMENT from scored posts → then SCAN new group`)
    }

    // Phase A: Try to comment on BEST pre-scanned posts first (from previous scans)
    if (!scanFirst && commentCheck.allowed && tracker.get('comment') < maxCommentsSession) {
      try {
        const bestPosts = await getBestPosts({ campaignId: campaign_id, limit: 3, supabase })
        if (bestPosts.length > 0) {
          const bestGroup = bestPosts[0]
          console.log(`[NURTURE] Found ${bestPosts.length} pre-scored posts, best in "${bestGroup.group_name}" (score: ${bestGroup.ai_score})`)
          // Navigate to best group and comment on scored posts
          // (this reuses existing comment logic below by prioritizing this group)
          const scoredGroup = groupsToVisit.find(g => g.fb_group_id === bestGroup.fb_group_id)
          if (scoredGroup) {
            // Move this group to front of visit list
            const idx = groupsToVisit.indexOf(scoredGroup)
            if (idx > 0) { groupsToVisit.splice(idx, 1); groupsToVisit.unshift(scoredGroup) }
          }
        }
      } catch {}
    }

    for (const group of groupsToVisit) {
      // Group visit rate limit: max 2 nicks in same group within 30 min
      if (!canVisitGroup(group.fb_group_id, account_id)) {
        console.log(`[NURTURE] ⏭️ Skip "${group.name}" — group visit rate limit (${GROUP_VISIT_MAX} nicks/30min)`)
        continue
      }
      recordGroupVisit(group.fb_group_id, account_id)

      const result = { group_name: group.name, posts_found: 0, likes_done: 0, comments_done: 0, errors: [] }

      try {
        // Stay on DESKTOP Facebook (cookies work, no login overlay)
        const groupUrl = (group.url || `https://www.facebook.com/groups/${group.fb_group_id}`)
          .replace('://m.facebook.com', '://www.facebook.com')
        console.log(`[NURTURE] Visiting: ${group.name || group.fb_group_id}`)
        logger.log('visit_group', { target_type: 'group', target_id: group.fb_group_id, target_name: group.name, target_url: groupUrl })

        const _navStart = Date.now()
        await page.goto(groupUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })
        const _navMs = Date.now() - _navStart
        await R.sleepRange(2000, 4000)

        // Signal detection: slow load + redirect
        try {
          const signals = require('../../lib/signal-collector')
          signals.checkSlowLoad(account_id, payload.job_id, groupUrl, _navMs)
          signals.checkRedirectWarn(account_id, payload.job_id, groupUrl, page.url())
        } catch {}

        // Check for checkpoint/block
        const status = await checkAccountStatus(page, supabase, account_id)
        if (status.blocked) throw new Error(`Account blocked: ${status.detail}`)

        // Language check — analyze first 8 posts + group description
        const groupAnalysis = await page.evaluate(() => {
          const articles = document.querySelectorAll('[role="article"]')
          let viPosts = 0, enPosts = 0, otherPosts = 0, totalPosts = 0
          const VI_DIACRITICS = /[àáảãạăắằẳẵặâấầẩẫậèéẻẽẹêếềểễệìíỉĩịòóỏõọôốồổỗộơớờởỡợùúủũụưứừửữựỳýỷỹỵđ]/gi
          const VI_WORDS = /\b(của|này|trong|không|được|những|cái|một|các|có|cho|với|đang|và|là|tôi|bạn|mình|anh|chị|em|ơi|nhé|nhỉ|vậy|sao|thế|gì|nào|ạ|ừ|rồi|cũng|nhưng|nên|vì|hỏi|bác|mấy|xin|giúp)\b/gi
          const CJK = /[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/g

          // Also check group description
          const descEl = document.querySelector('[data-testid="group-about-card"], [aria-label="Group description"]')
          const descText = descEl ? (descEl.innerText || '').substring(0, 200) : ''
          const descVi = (descText.match(VI_DIACRITICS) || []).length + (descText.match(VI_WORDS) || []).length
          const descIsVi = descVi > 3

          let translatedCount = 0
          for (const a of [...articles].slice(0, 8)) {
            const text = (a.innerText || '').substring(0, 500)
            if (text.length < 20) continue
            totalPosts++

            // CRITICAL: detect auto-translated posts (FB translates EN→VN for VN users)
            const isTranslated = /ẩn bản gốc|xem bản gốc|see original|translated from|đã dịch|bản dịch/i.test(text)
            if (isTranslated) {
              translatedCount++
              enPosts++ // translated = originally foreign language
              continue
            }

            const viDiacritics = (text.match(VI_DIACRITICS) || []).length
            const viWords = (text.match(VI_WORDS) || []).length
            const cjkChars = (text.match(CJK) || []).length

            if (cjkChars > 5) { otherPosts++; continue }
            if (viDiacritics > 3 || viWords > 3) { viPosts++; continue }
            enPosts++
          }

          // Strict: need MAJORITY of posts to be Vietnamese (>50%)
          const viRatio = totalPosts > 0 ? viPosts / totalPosts : 0
          let lang = 'unknown'
          if (viRatio > 0.5) lang = 'vi'          // >50% VN posts → Vietnamese
          else if (enPosts > viPosts) lang = 'en'  // more EN than VN → English
          else if (otherPosts > 0) lang = 'other'
          // Override: if description is clearly Vietnamese, give benefit of doubt
          if (lang !== 'vi' && descIsVi && viRatio >= 0.3) lang = 'vi'

          return { totalPosts, viPosts, enPosts, otherPosts, translatedCount, viRatio, lang, descIsVi }
        }).catch(() => ({ totalPosts: 0, viPosts: 0, enPosts: 0, otherPosts: 0, viRatio: 0, lang: 'unknown', descIsVi: false }))

        // ═══ AI GROUP EVALUATION ═══
        // AI decides if group is relevant — replaces hardcoded keyword/language checks
        // If AI fails → skip this group THIS RUN (not failure, will retry next time)
        // Cache result in ai_relevance for 7 days
        const topicKey = topic.toLowerCase().trim().replace(/\s+/g, '_').slice(0, 50)
        const cachedEval = group.ai_relevance?.[topicKey]
        const CACHE_TTL = 7 * 24 * 3600 * 1000
        const cacheValid = cachedEval?.evaluated_at && (Date.now() - new Date(cachedEval.evaluated_at).getTime()) < CACHE_TTL

        if (cacheValid) {
          const cachedDecision = cachedEval.decision || (cachedEval.relevant === false && cachedEval.score < 3 ? 'reject' : cachedEval.relevant && cachedEval.score >= 5 ? 'engage' : 'observe')
          result.aiDecision = { action: cachedDecision, score: cachedEval.score, tier: cachedEval.tier, reason: cachedEval.reason || 'cached' }

          if (cachedDecision === 'reject') {
            console.log(`[NURTURE] Skip "${group.name}" — cached REJECT (score: ${cachedEval.score}, reason: ${cachedEval.reason || 'cached'})`)
            result.errors.push('skipped: cached reject')
            groupResults.push(result)
            continue
          }
          console.log(`[NURTURE] "${group.name}" — cached ${cachedDecision.toUpperCase()} (score: ${cachedEval.score})`)
        }

        if (!cacheValid && topic) {
          // Rate limit AI evals: max 2 per run, rest will be evaluated in future runs
          if (aiGroupEvalsThisRun >= MAX_AI_GROUP_EVALS) {
            console.log(`[NURTURE] ⚠️ "${group.name}" — skipping AI eval (${aiGroupEvalsThisRun}/${MAX_AI_GROUP_EVALS} evals this run), will evaluate next run`)
            // Don't skip the group — let it proceed without eval (give benefit of doubt)
          } else {
          // Need AI evaluation — extract group info from page
          try {
            const { evaluateGroup } = require('../../lib/ai-filter')

            // Scroll down to trigger FB lazy-loading more articles
            await humanScroll(page)
            await R.sleepRange(1500, 3000)
            await humanScroll(page)
            await R.sleepRange(1000, 2000)

            const groupInfo = await page.evaluate(() => {
              const nameEl = document.querySelector('h1') || document.querySelector('[role="main"] span[dir="auto"]')
              const name = nameEl?.textContent?.trim() || ''
              let description = ''
              const aboutEls = document.querySelectorAll('[role="main"] span[dir="auto"]')
              for (const el of aboutEls) {
                const t = el.textContent?.trim() || ''
                if (t.length > 30 && t.length < 500 && t !== name) { description = t; break }
              }
              const posts = []
              const articles = document.querySelectorAll('[role="article"]')
              for (const article of [...articles].slice(0, 8)) {
                // Skip nested articles (comments)
                const parentArticle = article.parentElement?.closest('[role="article"]')
                if (parentArticle && parentArticle !== article) continue

                let postText = ''
                // Try div[dir="auto"] first, fallback to article.innerText
                for (const d of article.querySelectorAll('div[dir="auto"]')) {
                  const t = d.innerText?.trim() || ''
                  if (t.length > 10 && t.length > postText.length) postText = t
                }
                if (!postText) {
                  postText = (article.innerText || '').substring(0, 300).trim()
                }
                if (postText.length >= 10) posts.push({ text: postText.substring(0, 200) })
              }
              return { name: name || '', description, posts, member_count: 0 }
            }).catch(() => null)

            if (groupInfo && groupInfo.posts.length > 0) {
              aiGroupEvalsThisRun++
              const aiResult = await evaluateGroup(groupInfo, topic, payload.owner_id)
              // ── Structured AI Decision ──
              const aiDecision = {
                action: 'reject', // default
                score: aiResult.score || 0,
                tier: aiResult.tier || 'tier3_irrelevant',
                relevant: aiResult.relevant === true,
                reason: aiResult.reason || '',
                language: aiResult.language || 'unknown',
              }

              // Decision rules: script uses these thresholds
              if (aiResult.relevant && aiResult.score >= 5) {
                aiDecision.action = 'engage'     // high confidence — like + comment
              } else if (aiResult.relevant || aiResult.score >= 3) {
                aiDecision.action = 'observe'    // medium confidence — like only, no comment
              } else {
                aiDecision.action = 'reject'     // low confidence — skip entirely
              }

              console.log(`[NURTURE] AI eval "${group.name}" → ${aiDecision.action.toUpperCase()} (score:${aiDecision.score}, tier:${aiDecision.tier}) — ${aiDecision.reason} [${aiGroupEvalsThisRun}/${MAX_AI_GROUP_EVALS}]`)

              // Cache result with decision for future runs
              try {
                const prev = group.ai_relevance || {}
                prev[topicKey] = { ...aiResult, decision: aiDecision.action, evaluated_at: new Date().toISOString() }
                await supabase.from('fb_groups').update({
                  ai_relevance: prev,
                  ai_note: (aiResult.note || aiResult.reason || '').slice(0, 300),
                }).eq('fb_group_id', group.fb_group_id).eq('account_id', account_id)
              } catch {}

              // Log AI decision to activity log — detailed enough to debug
              logger.log('ai_evaluate_group', {
                target_type: 'group', target_name: group.name,
                result_status: aiDecision.action === 'reject' ? 'skipped' : 'success',
                details: {
                  decision: aiDecision.action,
                  score: aiDecision.score,
                  tier: aiDecision.tier,
                  relevant: aiDecision.relevant,
                  reason: aiDecision.reason,
                  language: aiDecision.language,
                  group_tags: group.tags || [],
                  topic,
                },
              })

              // Store decision on the group result for later use (comment gating)
              result.aiDecision = aiDecision

              if (aiDecision.action === 'reject') {
                result.errors.push(`skipped: AI decision=reject (score:${aiDecision.score}, reason:${aiDecision.reason})`)
                groupResults.push(result)
                continue
              }
            } else {
              // Page didn't load posts — skip this run, DON'T cache, retry next time
              console.log(`[NURTURE] ⚠️ "${group.name}" — could not extract posts for AI eval, will retry`)
              result.errors.push('skipped: no posts for AI eval')
              groupResults.push(result)
              continue
            }
          } catch (aiErr) {
            // AI failed — NOT a failure, just skip this group this run
            console.log(`[NURTURE] ⚠️ AI eval failed for "${group.name}": ${aiErr.message} — will retry next run`)
            // Continue to next group, don't block, don't cache
            result.errors.push('skipped: AI eval failed (will retry)')
            groupResults.push(result)
            continue
          }
          } // end rate limit else
        }

        // Browse feed naturally — scroll to load posts
        await humanMouseMove(page)
        for (let s = 0; s < 4; s++) {
          await humanScroll(page)
          await R.sleepRange(1000, 2000)
        }

        // Debug: check page state and dump DOM info
        try {
          const debugInfo = await page.evaluate(() => {
            const articles = document.querySelectorAll('[role="article"]')
            const buttons = document.querySelectorAll('[role="button"]')
            const likeButtons = [...buttons].filter(b => {
              const l = (b.getAttribute('aria-label') || '').toLowerCase()
              const t = (b.innerText || '').trim().toLowerCase()
              return l.includes('like') || l.includes('thích') || t === 'like' || t === 'thích'
            })
            return {
              url: location.href,
              isLoggedIn: !!document.querySelector('[aria-label="Your profile"], [aria-label="Account"], [data-pagelet="ProfileActions"], [aria-label="Trang cá nhân của bạn"], [aria-label="Tài khoản"], [aria-label="Thông báo"]'),
              articlesCount: articles.length,
              buttonsCount: buttons.length,
              likeButtonsCount: likeButtons.length,
              likeLabels: likeButtons.slice(0, 5).map(b => ({
                label: b.getAttribute('aria-label'),
                text: (b.innerText || '').trim().substring(0, 30),
                pressed: b.getAttribute('aria-pressed'),
              })),
              bodyText: (document.body?.innerText || '').substring(0, 200),
            }
          })
          const fs = require('fs')
          const debugPath = require('path').join(__dirname, '..', '..', 'debug', `nurture-dom-${Date.now()}.json`)
          fs.writeFileSync(debugPath, JSON.stringify(debugInfo, null, 2))
          console.log(`[NURTURE] DOM: ${debugInfo.articlesCount} articles, ${debugInfo.likeButtonsCount} like btns, logged=${debugInfo.isLoggedIn}, url=${debugInfo.url}`)
        } catch (e) { console.warn('[NURTURE] DOM debug failed:', e.message) }

        // ===== LIKE POSTS (desktop, JS-based) =====
        if (likeCheck.allowed && tracker.get('like') < maxLikesSession) {
          const maxLikes = getActionParams(parsed_plan, 'like', { countMin: 3, countMax: 5 }).count
          let likesInGroup = 0

          // Find MAIN POST like buttons only (NOT comment like buttons)
          // Key: only look in article toolbar area, skip nested comment articles
          const likeableInfo = await page.evaluate(() => {
            const results = []
            const articles = document.querySelectorAll('[role="article"]')
            for (const article of [...articles].slice(0, 15)) {
              // Skip nested articles (comments inside posts)
              const parentArticle = article.parentElement?.closest('[role="article"]')
              if (parentArticle && parentArticle !== article) continue

              // Skip spam/ads: check post content
              const postBody = (article.querySelector('div[dir="auto"]')?.innerText || '').toLowerCase()
              const spamWords = ['inbox', 'liên hệ ngay', 'giảm giá', 'mua ngay', 'đặt hàng', 'chuyên cung cấp', 'dịch vụ giá rẻ']
              const spamScore = spamWords.filter(w => postBody.includes(w)).length
              if (spamScore >= 2) continue // skip spam posts

              // Find like button in toolbar area (not in comment sections)
              const toolbar = article.querySelector('[role="group"]')
              const searchArea = toolbar || article
              const allBtns = searchArea.querySelectorAll('[role="button"]')
              for (const btn of allBtns) {
                const label = btn.getAttribute('aria-label') || ''
                const text = (btn.innerText || '').trim()
                const pressed = btn.getAttribute('aria-pressed')
                if (
                  (/^(Like|Thích|Thich)$/i.test(label) || /^(Like|Thích|Thich)$/i.test(text)) &&
                  pressed !== 'true'
                ) {
                  // Extract post permalink from article (multiple strategies)
                  let postUrl = null
                  const selectors = [
                    'a[href*="/posts/"]', 'a[href*="/permalink/"]', 'a[href*="story_fbid"]',
                    'a[href*="/groups/"][role="link"]'
                  ]
                  for (const sel of selectors) {
                    if (postUrl) break
                    for (const link of article.querySelectorAll(sel)) {
                      const href = link.href || ''
                      if (href.match(/\/(posts|permalink)\/\d+/) || href.includes('story_fbid')) {
                        postUrl = href.split('?')[0]; break
                      }
                    }
                  }
                  // Extract engagement counts from article
                  let reactions = 0, commentCount = 0
                  const engText = article.innerText || ''
                  const reactMatch = engText.match(/(\d+[\d,.]*[KkMm]?)\s*(reactions?|lượt thích|người đã bày tỏ)/i)
                  if (reactMatch) {
                    let raw = reactMatch[1].replace(/[,.]/g, '')
                    if (/[Kk]/.test(raw)) reactions = Math.round(parseFloat(raw) * 1000)
                    else if (/[Mm]/.test(raw)) reactions = Math.round(parseFloat(raw) * 1000000)
                    else reactions = parseInt(raw) || 0
                  }
                  const cmtMatch = engText.match(/(\d+[\d,.]*)\s*(comments?|bình luận)/i)
                  if (cmtMatch) commentCount = parseInt(cmtMatch[1].replace(/[,.]/g, '')) || 0

                  results.push({ label, text, pressed, index: results.length, postUrl, reactions, commentCount })
                  btn.setAttribute('data-nurture-like', results.length - 1)
                }
              }
            }
            return results
          })

          result.posts_found = likeableInfo.length
          console.log(`[NURTURE] Found ${likeableInfo.length} likeable posts in DOM`)

          const likesToDo = Math.min(maxLikes, likeableInfo.length, maxLikesSession - tracker.get('like'))

          for (let i = 0; i < likesToDo; i++) {
            try {
              // Re-find the button using the data attribute we set
              const btn = await page.$(`[data-nurture-like="${i}"]`)
              if (!btn) continue

              await btn.scrollIntoViewIfNeeded()
              await R.sleepRange(800, 1500)

              // Click using dispatchEvent for React compatibility
              await page.evaluate((idx) => {
                const el = document.querySelector(`[data-nurture-like="${idx}"]`)
                if (!el) return
                // Dispatch full mouse event sequence for React
                const rect = el.getBoundingClientRect()
                const x = rect.left + rect.width / 2
                const y = rect.top + rect.height / 2
                const opts = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y }
                el.dispatchEvent(new MouseEvent('mousedown', opts))
                el.dispatchEvent(new MouseEvent('mouseup', opts))
                el.dispatchEvent(new MouseEvent('click', opts))
              }, i)

              await R.sleepRange(1500, 2500)

              // Count as success — strict verification unreliable (FB re-renders)
              likesInGroup++
              totalLikes++
              tracker.increment('like')
              await supabase.rpc('increment_budget', {
                p_account_id: account_id,
                p_action_type: 'like',
              })
              console.log(`[NURTURE] Liked #${totalLikes} (session: ${tracker.get('like')}/${maxLikesSession})`)
              logger.log('like', { target_type: 'group', target_id: group.fb_group_id, target_name: group.name, target_url: group.url, details: { post_url: likeableInfo[i]?.postUrl || null, reactions: likeableInfo[i]?.reactions || 0, comments: likeableInfo[i]?.commentCount || 0 } })

              // Human delay between likes (minGapSeconds: 2)
              await R.sleepRange(2000, 5000)
            } catch (err) {
              result.errors.push(`like: ${err.message}`)
            }
          }
          result.likes_done = likesInGroup
        }

        // ===== COMMENT ON POSTS (desktop — click comment button in feed) =====
        // Gate: only comment if AI decision is 'engage' (not 'observe')
        const canComment = result.aiDecision?.action !== 'observe' // observe = like only
        if (canComment && commentCheck.allowed && tracker.get('comment') < maxCommentsSession) {
          const maxComments = getActionParams(parsed_plan, 'comment', { countMin: 1, countMax: 2 }).count

          // Get ALL previously commented posts for this USER (never comment same post twice, ANY campaign)
          const { data: prevComments } = await supabase
            .from('comment_logs')
            .select('post_url, fb_post_id')
            .eq('owner_id', payload.owner_id || payload.created_by)
            .not('post_url', 'is', null)
            .order('created_at', { ascending: false })
            .limit(1000)
          const commentedUrls = new Set()
          const commentedPostIds = new Set()
          for (const c of (prevComments || [])) {
            if (c.post_url) commentedUrls.add(c.post_url)
            if (c.fb_post_id) commentedPostIds.add(c.fb_post_id)
          }

          // === EXPAND "See more" / "Xem thêm" links to get full post content ===
          // FB truncates long posts behind these links — click them so AI sees full context
          try {
            const expanded = await page.evaluate(() => {
              const articles = document.querySelectorAll('[role="article"]')
              let clicked = 0
              for (const article of [...articles].slice(0, 10)) {
                // Skip nested
                const parent = article.parentElement?.closest('[role="article"]')
                if (parent && parent !== article) continue
                // Find "See more" / "Xem thêm" within article (NOT in toolbar)
                for (const el of article.querySelectorAll('div[role="button"], span[role="button"]')) {
                  const text = (el.innerText || '').trim().toLowerCase()
                  if (text === 'xem thêm' || text === 'see more' || text === 'xem them') {
                    try { el.click(); clicked++ } catch {}
                    break
                  }
                }
              }
              return clicked
            })
            if (expanded > 0) {
              console.log(`[NURTURE] Expanded ${expanded} 'See more' links`)
              await R.sleepRange(800, 1500) // wait for content to render
            }
          } catch {}

          // Extract ALL posts with content + tag comment buttons
          const commentableInfo = await page.evaluate(() => {
            const articles = document.querySelectorAll('[role="article"]')
            const results = []
            for (const article of [...articles].slice(0, 10)) {
              // Skip nested (comment articles)
              const parent = article.parentElement?.closest('[role="article"]')
              if (parent && parent !== article) continue

              // Extract post body — allow up to 5000 chars now that "See more" is expanded
              let body = ''
              const bodyEl = article.querySelector('[data-ad-preview="message"], [data-ad-comet-preview="message"]')
              if (bodyEl) body = bodyEl.innerText.trim()
              if (!body || body.length < 10) {
                for (const d of article.querySelectorAll('div[dir="auto"]')) {
                  const t = d.innerText.trim()
                  if (t.length > body.length && t.length < 5000) body = t
                }
              }
              if (body.length < 10) continue

              // Extract author
              const authorEl = article.querySelector('a[role="link"] strong, h2 a, h3 a')
              const author = authorEl ? authorEl.textContent.trim() : ''

              // Extract post URL
              let postUrl = null
              for (const link of article.querySelectorAll('a[href*="/posts/"], a[href*="/permalink/"], a[href*="story_fbid"]')) {
                const href = link.href || ''
                if (href.match(/\/(posts|permalink)\/\d+/) || href.includes('story_fbid')) {
                  postUrl = href.split('?')[0]; break
                }
              }

              // Check translated
              const isTranslated = /ẩn bản gốc|xem bản gốc|see original|đã dịch|bản dịch/i.test(article.innerText || '')

              // Tag comment button
              const toolbar = article.querySelector('[role="group"]') || article
              for (const btn of toolbar.querySelectorAll('[role="button"], a')) {
                const l = (btn.getAttribute('aria-label') || '').toLowerCase()
                const t = (btn.innerText || '').trim().toLowerCase()
                if (l.includes('comment') || l.includes('bình luận') || /^(comment|bình luận)$/i.test(t)) {
                  btn.setAttribute('data-nurture-comment', results.length)
                  break
                }
              }

              // Keep up to 1500 chars per post (was 400) — AI needs context
              results.push({ index: results.length, postUrl, body: body.substring(0, 1500), author, isTranslated })
            }
            return results
          })

          // Filter: skip translated, already commented (by ANY nick in this campaign), spam
          const eligible = commentableInfo.filter(p => {
            if (p.isTranslated) return false
            if (p.postUrl && commentedUrls.has(p.postUrl)) return false
            // Also check fb_post_id extracted from URL
            if (p.postUrl) {
              const m = p.postUrl.match(/(?:posts|permalink)\/(\d+)/) || p.postUrl.match(/story_fbid=(\d+)/)
              if (m && commentedPostIds.has(m[1])) return false
            }
            const lower = p.body.toLowerCase()
            const spamWords = ['inbox', 'liên hệ ngay', 'giảm giá', 'mua ngay', 'chuyên cung cấp']
            if (spamWords.filter(w => lower.includes(w)).length >= 2) return false
            return true
          })

          console.log(`[NURTURE] Extracted ${commentableInfo.length} posts, ${eligible.length} eligible for comment`)

          // === SMART SKIP: 0 eligible posts → record skip + move to next group ===
          if (eligible.length === 0) {
            await recordGroupSkip(supabase, account_id, group.fb_group_id)
            console.log(`[NURTURE] Skip "${group.name}" — 0 eligible posts (consecutive skips will increment)`)
          } else {
            // Has eligible posts → record yield (resets consecutive_skips)
            await recordGroupYield(supabase, account_id, group.fb_group_id, eligible.length)
          }

          // === DETECT GROUP LANGUAGE from sample of eligible posts ===
          // Use cached group.language if known, else detect now and persist
          let groupLanguage = group.language || null
          if (!groupLanguage && eligible.length >= 3) {
            try {
              groupLanguage = detectGroupLanguage(eligible)
              if (groupLanguage && groupLanguage !== 'unknown') {
                // Cache to DB for future runs
                supabase.from('fb_groups')
                  .update({ language: groupLanguage })
                  .eq('account_id', account_id).eq('fb_group_id', group.fb_group_id)
                  .then(() => {}, () => {})
                console.log(`[NURTURE] Detected group language: ${groupLanguage} for "${group.name}"`)
              }
            } catch {}
          }

          // === LANGUAGE GATE: nick profile vs group language mismatch ===
          // If nick is VN profile and group is EN, only do likes (no commenting)
          // Mature nicks (60+ days) can comment in foreign language groups
          const nickLang = account.profile_language || 'vi'
          const langMismatch = groupLanguage === 'en' && nickLang === 'vi'
          let allowCommentInGroup = true
          if (langMismatch && nickAge < 60) {
            console.log(`[NURTURE] Lang mismatch: ${nickLang} nick in ${groupLanguage} group (age ${nickAge}d) — like only, no comment`)
            allowCommentInGroup = false
          } else if (langMismatch) {
            console.log(`[NURTURE] Lang mismatch but nick mature (${nickAge}d) — comment allowed in ${groupLanguage}`)
          }

          // === AI BRAIN: Deep evaluation of which posts are worth engaging ===
          let aiSelected = []
          const postEvaluations = new Map() // store AI's reasoning per post
          if (eligible.length > 0) {
            try {
              // Fetch campaign details for context
              let campaignData = null
              if (campaign_id) {
                const { data: cData } = await supabase.from('campaigns')
                  .select('name, topic, requirement').eq('id', campaign_id).single()
                campaignData = cData
              }

              const evaluated = await evaluatePosts({
                posts: eligible,
                campaign: campaignData,
                nick: { username: account.username, created_at: account.created_at, mission: config?.nick_mission },
                group: { name: group.name, member_count: group.member_count, description: group.description },
                topic,
                maxPicks: Math.min(maxComments, eligible.length),
                ownerId: payload.owner_id,
                brandConfig, // AI now decides ad_opportunity contextually — no keyword matching
                groupLanguage, // language hint for AI
              })

              if (evaluated.length > 0) {
                aiSelected = evaluated.map(e => {
                  const post = eligible[e.index - 1]
                  if (post) postEvaluations.set(post.index, e) // save AI reasoning
                  return post
                }).filter(Boolean)

                console.log(`[NURTURE] AI Brain evaluated ${eligible.length} posts, selected ${aiSelected.length}:`)
                for (const e of evaluated) {
                  const p = eligible[e.index - 1]
                  console.log(`  → score:${e.score} [${p?.author}] "${(p?.body || '').substring(0, 60)}..." — ${e.reason}`)
                }

                logger.log('ai_evaluate_posts', {
                  target_type: 'group', target_name: group.name,
                  details: { total_eligible: eligible.length, selected: evaluated.length, evaluations: evaluated },
                })

                // SAVE scored posts to DB for future comment sessions
                try {
                  await scanGroupPosts({
                    posts: eligible, group: { ...group, fb_group_id: group.fb_group_id },
                    campaign: campaignData, nick: { username: account.username },
                    topic, ownerId: payload.owner_id, brandConfig,
                    supabase, campaignId: campaign_id,
                  })
                } catch {}
              } else {
                console.log(`[NURTURE] AI Brain says NO posts worth engaging in "${group.name}" (topic: ${topic})`)
                logger.log('ai_evaluate_posts', {
                  target_type: 'group', target_name: group.name, result_status: 'skipped',
                  details: { total_eligible: eligible.length, selected: 0, reason: 'no_relevant_posts' },
                })
              }
            } catch (err) {
              console.warn(`[NURTURE] AI Brain evaluation failed: ${err.message}, falling back to simple selection`)
              // Fallback: take first N eligible posts
              aiSelected = eligible.slice(0, maxComments)
            }
          }

          // Language gate: 0 comments if nick can't speak group's language
          const commentsToDo = allowCommentInGroup
            ? Math.min(maxComments, aiSelected.length, maxCommentsSession - tracker.get('comment'))
            : 0
          console.log(`[NURTURE] Will comment on ${commentsToDo} posts${allowCommentInGroup ? '' : ' (skipped — language gate)'}`)

          let commented = 0
          for (const post of aiSelected) {
            if (commented >= commentsToDo) break

            try {
              const thisPostUrl = post.postUrl
              if (thisPostUrl && commentedUrls.has(thisPostUrl)) continue
              // Cross-nick dedup by fb_post_id
              if (thisPostUrl) {
                const m = thisPostUrl.match(/(?:posts|permalink)\/(\d+)/) || thisPostUrl.match(/story_fbid=(\d+)/)
                if (m && commentedPostIds.has(m[1])) { console.log(`[NURTURE] Skip post ${m[1]} — already commented by another nick`); continue }
              }

              const commentBtn = await page.$(`[data-nurture-comment="${post.index}"]`)
              if (!commentBtn) continue

              // Post text already extracted during AI selection
              const postText = post.body || ''
              const postAuthor = post.author || ''

              // Final safety: skip if too short
              if (postText.length < 15) { continue }

              await commentBtn.scrollIntoViewIfNeeded()
              await R.sleepRange(500, 1000)
              await commentBtn.click({ force: true, timeout: 5000 })
              await R.sleepRange(1500, 2500)

              // Find comment textbox (desktop contenteditable)
              const desktopCommentSels = [
                'div[contenteditable="true"][role="textbox"][aria-label*="comment" i]',
                'div[contenteditable="true"][role="textbox"][aria-label*="bình luận" i]',
                'div[contenteditable="true"][role="textbox"]',
              ]
              let commentBox = null
              for (const sel of desktopCommentSels) {
                try {
                  const els = await page.$$(sel)
                  for (const el of els) {
                    if (await el.isVisible().catch(() => false)) commentBox = el
                  }
                  if (commentBox) break
                } catch {}
              }

              if (!commentBox) {
                result.errors.push('comment: no comment box')
                continue
              }

              // Get AI Brain's evaluation for this specific post
              const evaluation = postEvaluations.get(post.index)
              const commentAngle = evaluation?.comment_angle || null
              const hasAdOpportunity = evaluation?.ad_opportunity === true
              const isLeadPotential = evaluation?.lead_potential === true
              // Per-post language: from AI eval, fall back to group language, default vi
              const postLanguage = evaluation?.comment_language || groupLanguage || 'vi'

              if (hasAdOpportunity) console.log(`[NURTURE] 📢 Ad opportunity on post #${post.index} by [${post.author}]`)
              if (isLeadPotential) console.log(`[NURTURE] 🎯 Lead potential: [${post.author}]`)

              // ── Ad opportunity check: use brand-aware comment if triggered ──
              let commentResult = null
              let adTriggered = false
              let campaignCtx = null
              const adConfig = config?.advertising || null

              if (campaign_id) {
                try {
                  const { data: cd } = await supabase.from('campaigns')
                    .select('name, topic, requirement').eq('id', campaign_id).single()
                  campaignCtx = cd
                } catch {}
              }

              // === AD TRIGGER: trust AI's contextual decision (no keyword matching) ===
              // hasAdOpportunity comes from evaluatePosts() which already considered brandConfig
              if (canDoAdComment && adCommentsToday < AD_COMMENT_DAILY_LIMIT && hasAdOpportunity && brandConfig?.brand_name && (evaluation?.score || 0) >= 6) {
                try {
                  // Extract any existing comments from the post to avoid duplicating brand mentions
                  const existingComments = Array.isArray(post.comments)
                    ? post.comments.map(c => c?.text || c?.body || '').filter(Boolean).slice(0, 5)
                    : []

                  const oppResult = await generateOpportunityComment({
                    postContent: postText,
                    brandName: brandConfig.brand_name,
                    brandDescription: brandConfig.brand_description || '',
                    brandVoice: brandConfig.brand_voice || brandConfig.tone || 'thân thiện, tự nhiên',
                    commentAngle: evaluation?.comment_angle || '',
                    existingComments,
                    language: postLanguage,
                    userId: payload.owner_id,
                  })
                  if (oppResult?.text && oppResult.text.length > 5) {
                    commentResult = oppResult
                    adTriggered = true
                    adCommentsToday++
                    console.log(`[NURTURE] 📢 Ad comment triggered by AI eval (score:${evaluation.score}, reason:"${(evaluation.ad_reason || '').substring(0, 60)}") — ad #${adCommentsToday}/${AD_COMMENT_DAILY_LIMIT}`)
                  }
                } catch (adErr) {
                  console.warn(`[NURTURE] Ad comment generation failed: ${adErr.message}, falling back to normal`)
                }
              }

              // Normal comment flow (if ad not triggered)
              if (!commentResult) {
                commentResult = await generateSmartComment({
                  postText, postAuthor,
                  group: { name: group.name, member_count: group.member_count },
                  campaign: campaignCtx,
                  nick: { username: account.username, created_at: account.created_at, mission: config?.nick_mission },
                  topic, commentAngle,
                  ownerId: payload.owner_id,
                  adConfig, hasAdOpportunity,
                  language: postLanguage,
                })
              }

              // Fallback to old generateComment if Brain fails
              if (!commentResult) {
                commentResult = await generateComment({
                  postText, groupName: group.name, topic,
                  style: config?.comment_style || 'casual',
                  language: postLanguage,
                  userId: payload.owner_id,
                  templates: config?.comment_templates,
                })
              }

              const commentText = typeof commentResult === 'object' ? commentResult.text : commentResult
              const isAI = typeof commentResult === 'object' ? (commentResult.ai || commentResult.smart) : false

              // === QUALITY GATE: Check comment quality before posting ===
              if (isAI && commentText.length > 10) {
                const gate = await qualityGateComment({
                  comment: commentText, postText,
                  group: { name: group.name },
                  topic, nick: { username: account.username },
                  ownerId: payload.owner_id,
                })
                if (!gate.approved) {
                  console.log(`[NURTURE] ❌ Quality gate REJECTED: "${commentText.substring(0, 50)}..." (score: ${gate.score}, reason: ${gate.reason})`)
                  logger.log('comment_rejected', {
                    target_type: 'group', target_name: group.name,
                    details: { comment: commentText, score: gate.score, reason: gate.reason, post_author: postAuthor },
                  })
                  continue // Skip this post, don't waste comment budget
                }
                console.log(`[NURTURE] ✅ Quality gate PASSED (score: ${gate.score})`)
              }

              // Extract post URL + ID for logging
              const thisUrl = post.postUrl || null
              let fbPostId = null
              if (thisUrl) {
                const m = thisUrl.match(/(?:posts|permalink)\/(\d+)/) || thisUrl.match(/story_fbid=(\d+)/)
                if (m) fbPostId = m[1]
              }

              // PRE-LOG: Create comment_logs entry BEFORE posting (status='posting')
              // This ensures we have a record even if typing/submit crashes
              let commentLogId = null
              try {
                const { data: logEntry } = await supabase.from('comment_logs').insert({
                  owner_id: payload.owner_id || payload.created_by, account_id,
                  fb_post_id: fbPostId,
                  comment_text: commentText, source_name: group.name,
                  status: 'posting', campaign_id,
                  ai_generated: isAI,
                  post_url: thisUrl,
                }).select('id').single()
                commentLogId = logEntry?.id
              } catch (logErr) {
                console.warn(`[NURTURE] Pre-log failed: ${logErr.message} — posting anyway`)
              }

              // Add to dedup BEFORE posting (prevent double-comment even if crash)
              if (thisUrl) commentedUrls.add(thisUrl)
              if (fbPostId) commentedPostIds.add(fbPostId)

              // TYPE + SUBMIT comment
              await commentBox.click({ force: true, timeout: 5000 })
              await R.sleepRange(500, 1000)
              for (const char of commentText) {
                await page.keyboard.type(char, { delay: Math.random() * 80 + 30 })
              }
              await R.sleepRange(800, 1500)
              await page.keyboard.press('Enter')
              await R.sleepRange(2000, 4000)

              // POST-SUCCESS: Update log status + increment counters
              totalComments++
              tracker.increment('comment')
              result.comments_done++
              commented++

              // Update comment_logs status to 'done'
              if (commentLogId) {
                try { await supabase.from('comment_logs').update({ status: 'done' }).eq('id', commentLogId) } catch {}
              }

              // Increment budget (separate try/catch — don't crash if this fails)
              try { await supabase.rpc('increment_budget', { p_account_id: account_id, p_action_type: 'comment' }) } catch {}

              // Mark post as commented in group_post_scores (for scan-based flow)
              if (fbPostId) {
                try { await supabase.from('group_post_scores').update({ commented: true, commented_at: new Date().toISOString() })
                  .eq('fb_post_id', fbPostId).eq('owner_id', payload.owner_id || payload.created_by) } catch {}
              }

              const isSoftAd = adTriggered || (hasAdOpportunity && brandConfig?.brand_name && commentText.toLowerCase().includes(brandConfig.brand_name.toLowerCase()))
              console.log(`[NURTURE] ✅ Commented #${totalComments} (${isAI ? 'AI' : 'template'}${adTriggered ? ' +AD-TRIGGERED' : isSoftAd ? ' +AD' : ''}): "${commentText.substring(0, 50)}..."`)

              // Flag lead_potential authors for friend request pipeline
              if (isLeadPotential && post.author && campaign_id) {
                try {
                  // Extract author FB ID from post if available
                  const authorUid = post.authorFbId || null
                  if (authorUid) {
                    await supabase.from('target_queue').upsert({
                      campaign_id,
                      source_role_id: role_id,
                      target_role_id: role_id, // will be reassigned by connect role
                      fb_user_id: authorUid,
                      fb_user_name: post.author,
                      source_group_name: group.name,
                      active_score: 80, // high score = lead potential from AI
                      status: 'pending',
                      ai_score: evaluation?.score || 7,
                      ai_type: 'potential_buyer',
                      ai_reason: `Lead flagged from comment: ${evaluation?.reason || 'AI detected'}`,
                    }, { onConflict: 'campaign_id,fb_user_id' })
                    console.log(`[NURTURE] 🎯 Added lead [${post.author}] to target_queue for FR`)
                  }
                } catch {}
              }
              const logActionType = adTriggered ? 'opportunity_comment' : 'comment'
              try { await logger.log(logActionType, { target_type: 'group', target_id: group.fb_group_id, target_name: group.name, target_url: group.url, details: { comment_text: commentText.substring(0, 200), post_text: postText.substring(0, 200), post_url: thisUrl, ai_generated: isAI, post_author: postAuthor, soft_ad: isSoftAd, ad_triggered: adTriggered, ad_opportunity: hasAdOpportunity, lead_potential: isLeadPotential, comment_angle: commentAngle } }) } catch {}

              await R.sleepRange(90000, 180000) // 90-180 seconds gap
            } catch (err) {
              result.errors.push(`comment: ${err.message}`)
              logger.log('comment', { target_type: 'group', target_name: group.name, result_status: 'failed', details: { error: err.message } })
            }
          }
        }
      } catch (err) {
        console.warn(`[NURTURE] Group "${group.name}" failed: ${err.message}`)
        result.errors.push(`group: ${err.message}`)
        if (err.message.includes('blocked') || err.message.includes('checkpoint')) {
          if (page) await saveDebugScreenshot(page, `nurture-blocked-${account_id}`)
          throw err
        }
      }

      // Opportunistic friend request — if plan has send_friend_request, scan active members in this group
      const hasFriendTask = (parsed_plan || []).some(s => s.action === 'send_friend_request')
      const friendCheck = hasFriendTask ? tracker.check('friend_request', account.daily_budget?.friend_request?.used || 0) : { allowed: false }
      if (hasFriendTask && friendCheck.allowed && result.comments_done > 0) {
        try {
          // Extract commenters/likers from current page (people who interacted = active members)
          const activeMembers = await page.evaluate(() => {
            const members = []
            const seen = new Set()
            // Find profile links in comment sections and reaction lists
            const profileLinks = document.querySelectorAll('a[href*="facebook.com/"][role="link"]')
            for (const link of profileLinks) {
              const href = link.href || ''
              const match = href.match(/facebook\.com\/(?:profile\.php\?id=(\d+)|([a-zA-Z0-9._]+))/)
              if (!match) continue
              const uid = match[1] || match[2]
              if (!uid || seen.has(uid) || uid === 'groups' || uid === 'pages' || uid.length < 3) continue
              seen.add(uid)
              const name = (link.textContent || '').trim()
              if (name && name.length > 1 && name.length < 50) {
                members.push({ fb_user_id: uid, name, profile_url: href.split('?')[0] })
              }
            }
            return members.slice(0, 10) // max 10 candidates
          }).catch(() => [])

          if (activeMembers.length > 0) {
            const maxFR = Math.min(2, friendCheck.remaining) // max 2 opportunistic FR per group
            let frSent = 0
            for (const member of activeMembers.slice(0, maxFR + 2)) { // check a few extra in case some fail
              if (frSent >= maxFR) break
              try {
                // Check if already friends or already sent request
                const { data: existing } = await supabase.from('friend_request_log')
                  .select('id').eq('account_id', account_id).eq('target_fb_id', member.fb_user_id).limit(1)
                if (existing?.length) continue

                // AI Brain: Evaluate if this person is worth connecting
                try {
                  const leadEval = await evaluateLeadQuality({
                    person: { name: member.name, fb_user_id: member.fb_user_id },
                    postContext: `Tương tác trong nhóm "${group.name}" về ${topic}`,
                    campaign: { name: rawTopic },
                    topic,
                    ownerId: payload.owner_id,
                  })
                  if (!leadEval.worth || leadEval.score < 4) {
                    console.log(`[NURTURE] Skip FR to ${member.name} — AI Brain: ${leadEval.reason} (score: ${leadEval.score}, type: ${leadEval.type})`)
                    continue
                  }
                  console.log(`[NURTURE] AI Brain approved FR to ${member.name} (score: ${leadEval.score}, type: ${leadEval.type})`)
                } catch {}

                // Navigate to profile, find Add Friend button
                await page.goto(member.profile_url, { waitUntil: 'domcontentloaded', timeout: 15000 })
                await R.sleepRange(1500, 3000)

                let addBtn = await page.$('div[aria-label="Add friend"], div[aria-label="Thêm bạn bè"], div[aria-label="Add Friend"]')
                if (!addBtn) {
                  const loc = page.locator('div[role="button"]:has-text("Add friend"), div[role="button"]:has-text("Thêm bạn")').first()
                  if (await loc.isVisible({ timeout: 1500 }).catch(() => false)) addBtn = await loc.elementHandle()
                }

                if (addBtn) {
                  await humanClick(page, addBtn)
                  await R.sleepRange(1000, 2500)
                  frSent++
                  tracker.increment('friend_request')
                  await supabase.rpc('increment_budget', { p_account_id: account_id, p_action_type: 'friend_request' })
                  await supabase.from('friend_request_log').insert({
                    account_id, campaign_id,
                    target_fb_id: member.fb_user_id, target_name: member.name,
                    target_profile_url: member.profile_url,
                    status: 'sent', sent_at: new Date(),
                  }).catch(() => {})
                  logger.log('friend_request', { target_type: 'profile', target_id: member.fb_user_id, target_name: member.name, target_url: member.profile_url })
                  console.log(`[NURTURE] 🤝 Friend request sent to ${member.name} (active in ${group.name})`)
                  await R.sleepRange(3000, 8000) // random gap between friend requests
                }
              } catch {}
            }
            if (frSent > 0) result.friends_sent = frSent
          }

          // Navigate back to group feed for next group
          if (activeMembers.length > 0) {
            await page.goto(`https://www.facebook.com/groups/${group.fb_group_id}`, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {})
            await R.sleepRange(1000, 2000)
          }
        } catch (frErr) {
          console.warn(`[NURTURE] Opportunistic FR failed: ${frErr.message}`)
        }
      }

      groupResults.push(result)

      if (groupsToVisit.indexOf(group) < groupsToVisit.length - 1) {
        await R.sleepRange(20000, 45000)
      }
    }

    // Screenshot if 0 results for debugging
    if (totalLikes === 0 && totalComments === 0 && page) {
      await saveDebugScreenshot(page, `nurture-zero-${account_id}`)
    }

    const duration = Math.round((Date.now() - startTime) / 1000)
    console.log(`[NURTURE] Done: ${totalLikes} likes, ${totalComments} comments in ${groupResults.length} groups (${duration}s)`)
    return {
      success: true,
      groups_visited: groupResults.length,
      likes: totalLikes,
      comments: totalComments,
      details: groupResults,
      duration_seconds: duration,
    }
  } catch (err) {
    if (page) await saveDebugScreenshot(page, `nurture-error-${account_id}`)
    throw err
  } finally {
    await logger.flush().catch(() => {})

    // Level B: Remember nick behavior patterns
    try {
      const { remember } = require('../../lib/ai-memory')
      if (campaign_id && account_id) {
        // Track comment success rate per nick
        const commentLogs = logger.buffer?.filter(l => l.action_type === 'comment') || []
        const commentSuccess = commentLogs.filter(l => l.result_status === 'success').length
        const commentTotal = commentLogs.length
        if (commentTotal > 0) {
          await remember(supabase, {
            campaignId: campaign_id, accountId: account_id,
            memoryType: 'nick_behavior', key: 'comment_success_rate',
            value: { rate: Math.round(commentSuccess / commentTotal * 100), sample: commentTotal },
          })
        }

        // Track which hour this nick is active
        const hour = new Date().getHours()
        await remember(supabase, {
          campaignId: campaign_id, accountId: account_id,
          memoryType: 'nick_behavior', key: 'active_hour_' + hour,
          value: { hour, actions: logger.flushed || 0 },
        })
      }
    } catch {}

    if (page) // Keep page on FB for session reuse
    await releaseSession(account_id, supabase)
  }
}

module.exports = campaignNurture
