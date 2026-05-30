/**
 * Campaign Handler: Nurture Group (Role: nurture)
 * Visit joined groups, like posts, leave natural comments
 * Uses desktop Facebook with JS-based interaction (bypasses overlay interception)
 * Comments use mobile Facebook URL per-post (proven in comment-post.js)
 */

const { getPage, releaseSession, getLocalGroups } = require('../../browser/session-pool')
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

  // Phase 1+2: load campaign details for filtering + scoring
  let campaignLanguage = 'vi'
  let onlyCommentDesignated = false
  const designatedGroupIds = []
  if (campaign_id) {
    try {
      const { data: _cl } = await supabase.from('campaigns').select('language, meta').eq('id', campaign_id).single()
      if (_cl?.language) campaignLanguage = _cl.language
      if (_cl?.meta?.only_comment_designated) {
        onlyCommentDesignated = true
        const targetGroups = _cl.meta.target_groups || []
        for (const gStr of targetGroups) {
          if (!gStr || typeof gStr !== 'string') continue
          const trimmed = gStr.trim()
          let fbGroupId = null
          const m = trimmed.match(/(?:facebook\.com|fb\.com)\/groups\/([^/?#\s]+)/i)
          if (m) {
            fbGroupId = m[1]
          } else if (/^\d+$/.test(trimmed)) {
            fbGroupId = trimmed
          }
          if (fbGroupId) designatedGroupIds.push(fbGroupId)
        }
      }
    } catch {}
  }

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

  if (!groups.length && campaign_id) {
    // Phase 9: read groups via campaign_groups junction (campaign-scoped, per-nick assigned)
    const { data: junctionRows } = await supabase
      .from('campaign_groups')
      .select('id, score, tier, status, last_nurtured_at, fb_groups!inner(id, fb_group_id, name, url, member_count, topic, tags, joined_via_campaign_id, ai_relevance, user_approved, consecutive_skips, last_yield_at, total_yields, language, score_tier, engagement_rate, ai_join_score, is_member, pending_approval, is_blocked, global_score)')
      .eq('campaign_id', campaign_id)
      .eq('assigned_nick_id', account_id)
      .eq('status', 'active')
    // Flatten: keep one row per group with junction fields merged
    const junctionGroups = (junctionRows || [])
      .map(r => r.fb_groups && ({
        ...r.fb_groups,
        // Junction tier/score take precedence over global fb_groups values
        score_tier: r.tier || r.fb_groups.score_tier,
        _junction_id: r.id,
        _junction_score: r.score,
        _junction_tier: r.tier,
        _junction_last_nurtured: r.last_nurtured_at,
      }))
      .filter(Boolean)
      // Still enforce membership gates (junction status can lag)
      .filter(g => g.is_member === true && g.pending_approval === false)
      .filter(g => !g.is_blocked)
      .filter(g => g.user_approved !== false)
    if (junctionGroups.length > 0) {
      groups = junctionGroups
      console.log(`[NURTURE] Phase 9: ${groups.length} groups from campaign_groups junction (nick ${account_id.slice(0,8)})`)
    }
  }

  // If strictly commenting in designated groups only, filter the active groups
  if (onlyCommentDesignated) {
    const initialCount = groups.length
    groups = groups.filter(g => designatedGroupIds.includes(g.fb_group_id))
    console.log(`[NURTURE] Strictly filtered groups list to designated groups only: ${groups.length} of ${initialCount} groups matched. Designated IDs:`, designatedGroupIds)
  }

  // 2026-05-27: DISABLED — legacy fallback group discovery removed.
  // The agent no longer supplements junction groups with groups from fb_groups.
  // Only groups explicitly added by the user to campaign_groups (is_member=true) are used.
  const junctionGroupsSaved = [...groups]

  // 2026-05-27: DISABLED — inline auto-scout/discover removed.
  // The agent no longer auto-joins new groups when the list is small.
  // Only campaign_groups with is_member=true (added by user) are used.
  if (!groups?.length) throw new Error('SKIP_no_groups_joined')

  // 2026-05-02: bump from 1-3 random → up to 10 groups in tier order.
  // Reason: per-group fail rate is high (DOM rotation, dead groups, bad cache).
  // Limited to 1-3 caused agent to give up after 1 dud → 0 actions per session.
  // Loop below breaks early when result.comments_done > 0 so we stop wasting
  // time once we've got at least 1 real comment.
  const groupsToVisit = groups.slice(0, Math.min(10, groups.length))

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
        // Bumped 2-4s → 5-8s + 1 initial scroll: FB feeds lazy-load via XHR
        // after DOMContentLoaded, scrape needed extra time + viewport push.
        await R.sleepRange(5000, 8000)
        try { await humanScroll(page); await R.sleepRange(1500, 2500) } catch {}

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
        const topicKey = (topic || '').toLowerCase().trim().replace(/\s+/g, '_').slice(0, 50)
        const cachedEval = group.ai_relevance?.[topicKey]
        // Rejected groups re-evaluated after 12h (content changes daily);
        // engage/observe results stay valid 2 days (stable signal).
        const _isRejectedCache = (cachedEval?.decision || '') === 'reject'
        const CACHE_TTL = _isRejectedCache ? 12 * 3600 * 1000 : 2 * 24 * 3600 * 1000
        const cacheValid = cachedEval?.evaluated_at && (Date.now() - new Date(cachedEval.evaluated_at).getTime()) < CACHE_TTL

        if (cacheValid) {
          const cachedDecision = cachedEval.decision || (cachedEval.score >= 3 || cachedEval.relevant ? 'engage' : 'reject')
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

              // Decision rules: lowered thresholds for more engagement
              if (aiResult.score >= 3 || aiResult.relevant) {
                aiDecision.action = 'engage'     // like + comment (was: score >= 5)
              } else {
                aiDecision.action = 'reject'     // skip entirely
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
            // 2026 FB DOM: combine [role="article"] with story_message-walked-up
            // containers (FB rotation). See comment scrape below for rationale.
            const articleSet = new Set()
            for (const a of document.querySelectorAll('[role="article"]')) articleSet.add(a)
            for (const msg of document.querySelectorAll('[data-ad-rendering-role="story_message"]')) {
              let p = msg
              for (let i = 0; i < 10 && p; i++) {
                p = p.parentElement
                if (!p) break
                if (p.getAttribute && p.getAttribute('role') === 'article') { articleSet.add(p); break }
                const hasInteractBtn = [...p.querySelectorAll('[role="button"]')].some(b => {
                  const lab = (b.getAttribute('aria-label') || '').toLowerCase()
                  const tt = (b.innerText || '').trim().toLowerCase()
                  return /\b(like|thích|thich|bình luận|comment)\b/.test(lab + ' ' + tt)
                })
                if (hasInteractBtn) { articleSet.add(p); break }
              }
            }
            const articles = [...articleSet]
            for (const article of articles.slice(0, 15)) {
              // Skip nested articles (comments inside posts)
              const parentArticle = article.parentElement?.closest('[role="article"]')
              if (parentArticle && parentArticle !== article) continue

              // Skip spam/ads: check post content
              const postBody = (article.querySelector('div[dir="auto"]')?.innerText || '').toLowerCase()
              const spamWords = ['inbox', 'liên hệ ngay', 'giảm giá', 'mua ngay', 'đặt hàng', 'chuyên cung cấp', 'dịch vụ giá rẻ']
              const spamScore = spamWords.filter(w => postBody.includes(w)).length
              if (spamScore >= 2) continue // skip spam posts

              // Find like button — 2026 FB DOM uses
              // `data-ad-rendering-role="like_button"` (no aria-label/text).
              // Try modern selector first, then fall back to text/aria-label.
              const toolbar = article.querySelector('[role="group"]')
              const searchArea = toolbar || article
              const modernLikeBtn = searchArea.querySelector('[data-ad-rendering-role="like_button"]')
              const allBtns = modernLikeBtn
                ? [(() => {
                    // Walk up to clickable button
                    let p = modernLikeBtn
                    for (let i = 0; i < 5 && p; i++) {
                      if (p.getAttribute && (p.getAttribute('role') === 'button' ||
                          p.tagName === 'A' || p.tagName === 'BUTTON')) return p
                      p = p.parentElement
                    }
                    return modernLikeBtn
                  })(), ...searchArea.querySelectorAll('[role="button"]')]
                : [...searchArea.querySelectorAll('[role="button"]')]
              for (const btn of allBtns) {
                const label = btn.getAttribute('aria-label') || ''
                const text = (btn.innerText || '').trim()
                const pressed = btn.getAttribute('aria-pressed')
                const isModernLike = btn === modernLikeBtn || btn.querySelector?.('[data-ad-rendering-role="like_button"]')
                if (
                  (isModernLike ||
                    /^(Like|Thích|Thich)$/i.test(label) || /^(Like|Thích|Thich)$/i.test(text)) &&
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

            // 2026-05-02 FALLBACK: when [role="article"] returned 0 likes
            // (FB DOM rotation), find LIKE buttons directly in the document
            // and walk up to a stable post container. Bypasses the article
            // selector entirely.
            if (results.length === 0) {
              const seen = new WeakSet()
              const allBtns = document.querySelectorAll('div[role="button"], a[role="button"], span[role="button"]')
              for (const btn of allBtns) {
                const label = btn.getAttribute('aria-label') || ''
                const text = (btn.innerText || '').trim()
                const pressed = btn.getAttribute('aria-pressed')
                // Permissive — FB may append count or prefix
                const isLikeBtn =
                  /\b(Like|Thích|Thich)\b/i.test(label) ||
                  /\b(Like|Thích|Thich)\b/i.test(text)
                if (!isLikeBtn || pressed === 'true') continue

                // Skip if this is a comment-section like (parent has comment article wrapper)
                let p = btn.parentElement
                let inCommentSection = false
                for (let i = 0; i < 8 && p; i++) {
                  const lab = (p.getAttribute && p.getAttribute('aria-label') || '').toLowerCase()
                  if (lab.includes('comment by') || lab.includes('bình luận của') || lab.includes('reply')) { inCommentSection = true; break }
                  p = p.parentElement
                }
                if (inCommentSection) continue

                // Walk up to find post container (with permalink)
                let container = btn
                for (let i = 0; i < 10 && container; i++) {
                  container = container.parentElement
                  if (!container) break
                  const hasPostLink = container.querySelector('a[href*="/posts/"], a[href*="/permalink/"], a[href*="story_fbid"], a[href*="pfbid"]')
                  if (hasPostLink) break
                }
                if (!container || seen.has(container)) continue
                seen.add(container)

                // Spam check
                const postBody = (container.innerText || '').toLowerCase()
                const spamWords = ['inbox', 'liên hệ ngay', 'giảm giá', 'mua ngay', 'đặt hàng', 'chuyên cung cấp', 'dịch vụ giá rẻ']
                const spamScore = spamWords.filter(w => postBody.includes(w)).length
                if (spamScore >= 2) continue

                let postUrl = null
                for (const link of container.querySelectorAll('a[href*="/posts/"], a[href*="/permalink/"], a[href*="story_fbid"], a[href*="pfbid"]')) {
                  const href = link.href || ''
                  if (href.match(/\/(posts|permalink)\/(pfbid[\w]+|\d+)/) || href.includes('story_fbid=') || href.match(/pfbid[\w]+/)) {
                    postUrl = href.split('?')[0]; break
                  }
                }

                results.push({ label, text, pressed, index: results.length, postUrl, reactions: 0, commentCount: 0, _from_fallback: true })
                btn.setAttribute('data-nurture-like', results.length - 1)
                if (results.length >= 8) break
              }
            }

            return results
          })

          result.posts_found = likeableInfo.length
          console.log(`[NURTURE] Found ${likeableInfo.length} likeable posts in DOM`)

          // 2026-05-02 DOM debug: log selector counts to DB so we can see why
          // scraper returns 0 (Electron renderer is sandboxed → fs.writeFileSync
          // dom dumps fail; only this DB-backed channel survives).
          try {
            const diagDom = await page.evaluate(() => ({
              articles: document.querySelectorAll('[role="article"]').length,
              story_msgs: document.querySelectorAll('[data-ad-rendering-role="story_message"]').length,
              like_btns_modern: document.querySelectorAll('[data-ad-rendering-role="like_button"]').length,
              cmt_btns_modern: document.querySelectorAll('[data-ad-rendering-role="comment_button"]').length,
              aria_thich_buttons: document.querySelectorAll('[aria-label="Thích"][role="button"]').length,
              aria_binhluan_buttons: document.querySelectorAll('[role="button"][aria-label*="ình luận"]').length,
              aria_viet_binhluan: document.querySelectorAll('[role="button"][aria-label*="Viết bình luận"]').length,
              body_text_len: document.body?.innerText?.length || 0,
              url: location.href,
            }))
            logger.log('nurture_dom_debug', {
              target_type: 'group',
              target_name: group.name,
              target_id: group.fb_group_id,
              details: { ...diagDom, likeable_found: likeableInfo.length },
            })
            console.log(`[NURTURE-DOM]`, JSON.stringify(diagDom))
          } catch (dErr) { console.warn('[NURTURE-DOM] diag failed:', dErr.message) }

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
        // Diagnostic: track where comment pipeline stops
        const commentDebug = { commentable: 0, eligible: 0, ai_selected: 0, attempted: 0, quality_rejected: 0, no_box: 0, gen_failed: 0 }
        result.comment_debug = commentDebug
        if (canComment && commentCheck.allowed && tracker.get('comment') < maxCommentsSession) {
          // 2026-05-02: bump 1-2 → 1-3 per group. Hermes evaluatePosts already
          // filters by campaign target/topic/quality — let it pick more posts
          // when group has rich content. Daily comment.max budget caps total.
          const maxComments = getActionParams(parsed_plan, 'comment', { countMin: 1, countMax: 3 }).count

          // Get ALL previously commented posts for this USER (never comment same post twice, ANY campaign)
          const { data: prevComments } = await supabase
            .from('comment_logs')
            .select('post_url, fb_post_id, created_at, account_id')
            .eq('owner_id', payload.owner_id || payload.created_by)
            .order('created_at', { ascending: false })
            .limit(1000)

          const commentedUrls = new Set()
          const commentedPostIds = new Set()
          const recentCommentedUrls = new Set()
          const recentCommentedPostIds = new Set()

          const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000)

          for (const c of (prevComments || [])) {
            if (c.post_url) commentedUrls.add(c.post_url)
            if (c.fb_post_id) commentedPostIds.add(c.fb_post_id)

            // Swarm anti-collision: if commented by ANOTHER of our nicks recently (last 60 mins)
            if (c.account_id !== account_id && c.created_at) {
              const commentTime = new Date(c.created_at)
              if (commentTime >= oneHourAgo) {
                if (c.post_url) recentCommentedUrls.add(c.post_url)
                if (c.fb_post_id) recentCommentedPostIds.add(c.fb_post_id)
              }
            }
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

          // Scroll to trigger FB lazy-loading of feed posts. Without this,
          // DOM at `domcontentloaded` may only contain the group header/about
          // article and zero actual posts. Retry up to 2 times if post count
          // is too low after the first pass.
          let commentableInfo = []
          for (let _scrollAttempt = 0; _scrollAttempt < 3; _scrollAttempt++) {
            if (_scrollAttempt > 0) {
              console.log(`[NURTURE] Scroll attempt ${_scrollAttempt + 1}/3 for "${group.name}" — previous had ${commentableInfo.length} posts`)
            }
            await humanScroll(page)
            await R.sleepRange(1500, 2500)
            if (_scrollAttempt < 2) {
              await humanScroll(page)
              await R.sleepRange(1000, 2000)
            }

            // Extract ALL posts with content + tag comment buttons
            commentableInfo = await page.evaluate(() => {
              const findCommentBtn = (art) => {
                // 1. Try modern data-ad-rendering-role
                const modernBtn = art.querySelector('[data-ad-rendering-role="comment_button"]')
                if (modernBtn) {
                  let clickTarget = modernBtn
                  for (let i = 0; i < 4 && clickTarget; i++) {
                    if (clickTarget.getAttribute && (
                        clickTarget.getAttribute('role') === 'button' ||
                        clickTarget.tagName === 'BUTTON' ||
                        clickTarget.tagName === 'A' ||
                        clickTarget.getAttribute('tabindex') === '0'
                    )) return clickTarget
                    clickTarget = clickTarget.parentElement
                  }
                  return modernBtn
                }

                // 2. Try by aria-label containing keywords
                const ariaBtns = art.querySelectorAll('[role="button"][aria-label*="bình luận" i], [role="button"][aria-label*="comment" i], a[aria-label*="bình luận" i], a[aria-label*="comment" i], button[aria-label*="bình luận" i], button[aria-label*="comment" i]')
                if (ariaBtns.length > 0) return ariaBtns[0]

                // 3. Try by inner text (soft checking - spaces, emoji, lowercase, etc.)
                const buttonsAndLinks = art.querySelectorAll('[role="button"], a, button, div[tabindex="0"]')
                for (const btn of buttonsAndLinks) {
                  const label = (btn.getAttribute('aria-label') || '').toLowerCase()
                  const text = (btn.innerText || '').trim().toLowerCase()
                  // Strip non-alphanumeric/non-vietnamese characters to handle emojis and special formatting
                  const cleanText = text.replace(/[^a-z0-9\sđđăâêôơưưáàảãạđíìỉĩịóòỏõọúùủũụýỳỷỹỵ]/gi, '').trim()
                  if (label.includes('comment') || label.includes('bình luận') ||
                      cleanText.includes('bình luận') || cleanText.includes('comment') ||
                      cleanText.includes('leave a comment') || cleanText.includes('viết bình luận')) {
                    return btn
                  }
                }

                // 4. Try looking for UFI comment list icon or SVGs that indicate commenting
                const svgs = art.querySelectorAll('svg')
                for (const svg of svgs) {
                  const parentBtn = svg.closest('[role="button"]') || svg.closest('a') || svg.closest('button')
                  if (parentBtn) {
                    const parentText = (parentBtn.innerText || '').toLowerCase()
                    if (parentText.includes('bình luận') || parentText.includes('comment')) {
                      return parentBtn
                    }
                    const html = svg.innerHTML.toLowerCase()
                    if (html.includes('comment') || html.includes('bình luận') || html.includes('uficomment')) {
                      return parentBtn
                    }
                  }
                }
                return null
              }

              // 2026 FB DOM: posts now use `data-ad-rendering-role="story_message"`
              // for the body div. Old `[role="article"]` still exists for some
              // post types but missed by FB's recent rotation. Combine both
              // sources by walking up from story_message to find its container.
              const articleSet = new Set()
              for (const a of document.querySelectorAll('[role="article"]')) articleSet.add(a)
              for (const msg of document.querySelectorAll('[data-ad-rendering-role="story_message"]')) {
                let p = msg
                for (let i = 0; i < 10 && p; i++) {
                  p = p.parentElement
                  if (!p) break
                  if (p.getAttribute && p.getAttribute('role') === 'article') {
                    articleSet.add(p); break
                  }
                  // Stop at any container that has a comment button + the story_message
                  const cmtBtns = [...p.querySelectorAll('[role="button"]')].filter(b => {
                    const lab = (b.getAttribute('aria-label') || '').toLowerCase()
                    const tt = (b.innerText || '').trim().toLowerCase()
                    return lab.includes('bình luận') || lab.includes('comment') ||
                           /\bbình\s+luận\b/.test(tt) || /\bcomment\b/.test(tt)
                  })
                  if (cmtBtns.length > 0) { articleSet.add(p); break }
                }
              }
              const articles = [...articleSet]
              const results = []
              const diag = { total: articles.length, skipped: { nested: 0, no_content: 0, comment: 0 }, story_message_count: document.querySelectorAll('[data-ad-rendering-role="story_message"]').length }

              // Build a set of COMMENT-section articles to exclude.
              // Comment articles have aria-label containing "Comment by/Bình luận của"
              // or sit inside a [role="article"][aria-label*="omment"] wrapper.
              const commentArticles = new Set()
              for (const a of articles) {
                const label = (a.getAttribute('aria-label') || '').toLowerCase()
                if (label.includes('comment by') || label.includes('bình luận của') ||
                    label.includes('reply') || label.includes('trả lời của')) {
                  commentArticles.add(a)
                  // Also mark all descendants as comments (replies to replies)
                  for (const sub of a.querySelectorAll('[role="article"]')) commentArticles.add(sub)
                }
              }

              for (const article of [...articles].slice(0, 20)) {
                // Skip comment articles (not feed posts)
                if (commentArticles.has(article)) { diag.skipped.comment++; continue }

                // Skip only if this article is INSIDE another non-comment article
                // (e.g. nested repost that we'll catch via the outer article).
                // We used to skip anything with a parent [role="article"], which was too
                // aggressive — FB wraps many post types in outer containers now.
                let parent = article.parentElement
                let isNested = false
                while (parent) {
                  if (parent.getAttribute && parent.getAttribute('role') === 'article') {
                    if (!commentArticles.has(parent)) { isNested = true }
                    break
                  }
                  parent = parent.parentElement
                }
                if (isNested) { diag.skipped.nested++; continue }

                // Extract post body — expanded selector list (FB changes DOM often)
                let body = ''
                const bodySelectors = [
                  '[data-ad-rendering-role="story_message"]',  // 2026 modern selector
                  '[data-ad-preview="message"]',
                  '[data-ad-comet-preview="message"]',
                  'div[data-ad-preview]',
                  '[data-testid="post_message"]',
                  'div[data-testid*="post"]',
                ]
                for (const sel of bodySelectors) {
                  const el = article.querySelector(sel)
                  if (el?.innerText?.trim()?.length > body.length) body = el.innerText.trim()
                }
                // Fallback: longest div[dir="auto"] that's not a button label
                if (body.length < 3) {
                  for (const d of article.querySelectorAll('div[dir="auto"]')) {
                    // Skip if inside a toolbar/button (like/comment/share labels)
                    if (d.closest('[role="button"]') || d.closest('[role="group"]')) continue
                    const t = (d.innerText || '').trim()
                    if (t.length > body.length && t.length < 5000 && t.length > 3) body = t
                  }
                }
                // Further fallback: longest <span> text (video/shared posts use spans)
                if (body.length < 3) {
                  for (const s of article.querySelectorAll('span')) {
                    if (s.closest('[role="button"]') || s.closest('[role="group"]')) continue
                    const t = (s.innerText || '').trim()
                    if (t.length > body.length && t.length > 20 && t.length < 2000) body = t
                  }
                }

                // Extract author — try many heading patterns
                let author = ''
                const authorSelectors = [
                  'h2 a[role="link"] strong',
                  'h3 a[role="link"] strong',
                  'h2 a strong',
                  'h3 a strong',
                  'h2 a[role="link"]',
                  'h3 a[role="link"]',
                  'h2 a',
                  'h3 a',
                  'a[role="link"] strong',
                  'strong a',
                  '[data-ad-comet-preview="message"] + * a',
                ]
                for (const sel of authorSelectors) {
                  const el = article.querySelector(sel)
                  const t = el?.textContent?.trim()
                  if (t && t.length > 0 && t.length < 80) { author = t; break }
                }

                // Extract post URL — expanded patterns incl. pfbid format (current FB)
                let postUrl = null
                const urlCandidates = article.querySelectorAll(
                  'a[href*="/posts/"], a[href*="/permalink/"], a[href*="story_fbid"], a[href*="/videos/"], a[href*="/photos/"]'
                )
                for (const link of urlCandidates) {
                  const href = link.href || ''
                  // Accept pfbid format + numeric + photo/video URLs with story_fbid
                  if (href.match(/\/(posts|permalink)\/(pfbid[\w]+|\d+)/) ||
                      href.includes('story_fbid=') ||
                      href.match(/\/(videos|photos)\/\d+/)) {
                    postUrl = href.split('?')[0]
                    break
                  }
                }

                // Skip only if NO content at all (no body, no url, no author)
                if (body.length < 3 && !postUrl && !author) {
                  diag.skipped.no_content++
                  continue
                }

                // Check translated
                const isTranslated = /ẩn bản gốc|xem bản gốc|see original|đã dịch|bản dịch/i.test(article.innerText || '')

                // Tag article container for scoped lookups later
                article.setAttribute('data-nurture-article', results.length)

                // Tag comment button using our robust helper findCommentBtn
                const commentBtnEl = findCommentBtn(article)
                if (commentBtnEl) {
                  commentBtnEl.setAttribute('data-nurture-comment', results.length)
                }

              // Fix 2 (Phase 6): grab up to 5 already-visible thread comments so the AI
              // can answer the actual discussion instead of restating the post body.
              // We DO NOT click "View more" — only what FB rendered inline. If the post has
              // no comments visible yet, threadComments stays empty and AI falls back to
              // post body only (current behavior).
              const threadComments = []
              try {
                // Comment containers on desktop are <li> items inside the comment list
                // (role="article" with depth, or aria-label containing "Comment by/Bình luận của")
                const commentNodes = article.querySelectorAll('[role="article"][aria-label*="omment" i], [role="article"][aria-label*="ình luận" i]')
                for (const c of commentNodes) {
                  if (threadComments.length >= 5) break
                  const label = c.getAttribute('aria-label') || ''
                  // aria-label is usually "Comment by John Doe" / "Bình luận của John"
                  const cAuthorMatch = label.match(/(?:by|của)\s+(.+?)(?:\s+\d|$)/i)
                  const cAuthor = cAuthorMatch ? cAuthorMatch[1].trim() : ''
                  // Body is the longest dir="auto" inside the comment node
                  let cBody = ''
                  for (const d of c.querySelectorAll('div[dir="auto"]')) {
                    const t = (d.innerText || '').trim()
                    if (t.length > cBody.length && t.length < 1000) cBody = t
                  }
                  if (cBody && cBody.length >= 4 && cBody !== body) {
                    threadComments.push({ author: cAuthor, text: cBody.substring(0, 300) })
                  }
                }
              } catch {}

                // Keep up to 1500 chars per post (was 400) — AI needs context
                results.push({ index: results.length, postUrl, body: body.substring(0, 1500), author, isTranslated, threadComments })
              }

              // 2026-05-02 FALLBACK: when [role="article"] returned 0 posts
              // (FB rotates DOM and breaks our selector), find COMMENT BUTTONS
              // first, walk up to a stable container, extract body from there.
              // Far more robust to FB DOM changes since the comment button text
              // ("Bình luận"/"Comment") rarely changes.
              if (results.length === 0) {
                diag.fallback_tried = true
                const seen = new WeakSet()
                const allBtns = document.querySelectorAll('div[role="button"], a[role="button"], span[role="button"]')
                for (const btn of allBtns) {
                  const lab = (btn.getAttribute('aria-label') || '').toLowerCase()
                  const txt = (btn.innerText || '').trim().toLowerCase()
                  // Permissive: FB may prefix with emoji or append count.
                  // Match "Bình luận", "💬 Bình luận", "Bình luận · 5", etc.
                  const isCommentBtn =
                    lab.includes('bình luận') || lab.includes('comment') ||
                    /\bbình\s+luận\b/.test(txt) || /\bcomment\b/.test(txt) ||
                    /\bviết\s+bình\s+luận\b/.test(txt) || /\bwrite\s+a?\s*comment\b/.test(txt)
                  if (!isCommentBtn) continue

                  // Walk up to find the post container — try various depths
                  let container = btn
                  for (let i = 0; i < 10 && container; i++) {
                    container = container.parentElement
                    if (!container) break
                    // Stop when we find a container with a post-like body
                    const hasPostLink = container.querySelector('a[href*="/posts/"], a[href*="/permalink/"], a[href*="story_fbid"], a[href*="pfbid"]')
                    const txtLen = (container.innerText || '').length
                    if (hasPostLink && txtLen > 30 && txtLen < 8000) break
                  }
                  if (!container || seen.has(container)) continue
                  seen.add(container)

                  // Extract body — longest div[dir="auto"] not inside button/group toolbar
                  let body = ''
                  for (const d of container.querySelectorAll('div[dir="auto"]')) {
                    if (d.closest('[role="button"]') || d.closest('[role="group"]')) continue
                    const t = (d.innerText || '').trim()
                    if (t.length > body.length && t.length < 5000 && t.length > 10) body = t
                  }
                  if (body.length < 10) continue

                  // Extract author
                  let author = ''
                  for (const sel of ['h2 a strong', 'h3 a strong', 'h2 a', 'h3 a', 'strong a', 'a[role="link"] strong']) {
                    const el = container.querySelector(sel)
                    const t = el?.textContent?.trim()
                    if (t && t.length > 0 && t.length < 80) { author = t; break }
                  }

                  // Extract URL
                  let postUrl = null
                  for (const link of container.querySelectorAll('a[href*="/posts/"], a[href*="/permalink/"], a[href*="story_fbid"], a[href*="pfbid"]')) {
                    const href = link.href || ''
                    if (href.match(/\/(posts|permalink)\/(pfbid[\w]+|\d+)/) || href.includes('story_fbid=') || href.match(/pfbid[\w]+/)) {
                      postUrl = href.split('?')[0]; break
                    }
                  }

                  // Tag the comment button so the comment loop can find it
                  btn.setAttribute('data-nurture-comment', results.length)

                  const isTranslated = /ẩn bản gốc|xem bản gốc|see original|đã dịch|bản dịch/i.test(container.innerText || '')
                  results.push({
                    index: results.length, postUrl, body: body.substring(0, 1500),
                    author, isTranslated, threadComments: [], _from_fallback: true,
                  })
                  if (results.length >= 8) break
                }
                diag.fallback_kept = results.length
              }

              // Return both posts + diagnostics so the agent can log why extraction failed
              return { posts: results, diag }
            })

            // Unwrap — support both old shape (array) and new shape ({posts, diag})
            const _extractResult = commentableInfo
            if (_extractResult && !Array.isArray(_extractResult) && _extractResult.posts) {
              commentableInfo = _extractResult.posts
              if (_scrollAttempt === 0 || commentableInfo.length === 0) {
                const d = _extractResult.diag
                console.log(`[NURTURE] DOM scan: ${d.total} articles, skipped: nested=${d.skipped.nested} no_content=${d.skipped.no_content} comment=${d.skipped.comment} → kept=${commentableInfo.length}`)
              }
            }

            // If we got >= 2 posts, stop scrolling. Otherwise retry.
            if (commentableInfo.length >= 2) break
          } // end scroll retry loop

          // Debug: save screenshot + DOM JSON if 0 posts extracted (even if likes worked)
          if (commentableInfo.length === 0) {
            try {
              const { saveDebugScreenshot } = require('./post-utils')
              await saveDebugScreenshot(page, `nurture-zero-${account_id}`)

              // Dump DOM info for diagnosis — what DOES exist on the page?
              const domDump = await page.evaluate(() => {
                const articles = [...document.querySelectorAll('[role="article"]')].slice(0, 10)
                return {
                  articlesCount: articles.length,
                  articleSamples: articles.map((a, i) => ({
                    idx: i,
                    ariaLabel: (a.getAttribute('aria-label') || '').substring(0, 120),
                    hasH2: !!a.querySelector('h2'),
                    hasH3: !!a.querySelector('h3'),
                    hasRoleGroup: !!a.querySelector('[role="group"]'),
                    bodyTextLen: (a.innerText || '').length,
                    bodyTextPreview: (a.innerText || '').substring(0, 200).replace(/\s+/g, ' '),
                    hasPostLink: !!a.querySelector('a[href*="/posts/"], a[href*="/permalink/"], a[href*="story_fbid"]'),
                  })),
                }
              })
              const fs = require('fs')
              const path = require('path')
              const os = require('os')
              // Use ~/.socialflow/debug — guaranteed writable, persists across
              // exe rebuilds (asar.unpacked debug/ gets wiped on rebuild).
              const debugDir = path.join(os.homedir(), '.socialflow', 'debug')
              try { fs.mkdirSync(debugDir, { recursive: true }) } catch {}
              try {
                fs.writeFileSync(
                  path.join(debugDir, `nurture-zero-dom-${account_id}-${Date.now()}.json`),
                  JSON.stringify(domDump, null, 2)
                )
                console.log(`[NURTURE] ⚠️ 0 commentable posts extracted — debug saved to ${debugDir}`)
              } catch (writeErr) {
                console.log(`[NURTURE] ⚠️ DOM dump write failed: ${writeErr.message}`)
              }
            } catch (e) {
              console.log(`[NURTURE] ⚠️ 0 commentable posts extracted — debug save failed: ${e.message}`)
            }
          }

          // Filter: skip translated, already commented (by ANY nick in this campaign), spam
          const eligible = commentableInfo.filter(p => {
            if (p.isTranslated) return false
            if (p.postUrl && commentedUrls.has(p.postUrl)) return false
            // Also check fb_post_id extracted from URL
            if (p.postUrl) {
              const m = p.postUrl.match(/(?:posts|permalink)\/(\d+)/) || p.postUrl.match(/story_fbid=(\d+)/)
              if (m && commentedPostIds.has(m[1])) return false
            }
            const lower = (p.body || '').toLowerCase()
            const spamWords = ['inbox', 'liên hệ ngay', 'giảm giá', 'mua ngay', 'chuyên cung cấp']
            if (spamWords.filter(w => lower.includes(w)).length >= 2) return false
            return true
          })

          commentDebug.commentable = commentableInfo.length
          commentDebug.eligible = eligible.length
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

          // === LANGUAGE GATE: skip English groups entirely for VN nicks ===
          // Per user request: nick VN không tương tác với group tiếng Anh
          // → mark group as skipped + record skip + move on to next group
          const nickLang = account.profile_language || 'vi'
          if (groupLanguage === 'en' && nickLang === 'vi') {
            console.log(`[NURTURE] ⏭️ Skip "${group.name}" — group is English, nick is VN (skipping entirely)`)
            await recordGroupSkip(supabase, account_id, group.fb_group_id)
            // Mark in DB so smart rotation deprioritizes this group permanently for VN nicks
            try {
              await supabase.from('fb_groups')
                .update({ language: 'en', user_approved: false })
                .eq('account_id', account_id).eq('fb_group_id', group.fb_group_id)
            } catch {}
            logger.log('visit_group', {
              target_type: 'group', target_name: group.name, target_url: group.url,
              result_status: 'skipped',
              details: { reason: 'english_group_vn_nick', group_language: groupLanguage },
            })
            groupResults.push(result)
            continue // skip to next group
          }
          const allowCommentInGroup = true

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
                // Fix 2: posts now carry threadComments (top 5 visible comments per article).
                // evaluatePosts uses them to understand the actual discussion thread.
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

                // Phase 3: upsert high-score posts into shared_posts pool for swarm
                try {
                  const rows = []
                  for (const e of evaluated) {
                    if ((e.score || 0) < 7) continue
                    const post = eligible[e.index - 1]
                    if (!post) continue
                    // Extract fb_post_id from URL
                    let postFbId = null
                    if (post.postUrl) {
                      const m = post.postUrl.match(/(?:posts|permalink)\/(\d+)/) || post.postUrl.match(/story_fbid=(\d+)/) || post.postUrl.match(/\/(\d{10,})/)
                      if (m) postFbId = m[1]
                    }
                    if (!postFbId) continue
                    const swarmTarget = e.score >= 9 ? 3 : (e.score >= 7 ? 2 : 1)
                    const isAdPost = e.is_ad_post === true || /sponsored|được tài trợ|promoted/i.test((post.body || '') + ' ' + (post.author || ''))
                    rows.push({
                      campaign_id,
                      group_fb_id: group.fb_group_id,
                      post_fb_id: postFbId,
                      post_content: (post.body || '').slice(0, 2000),
                      post_url: post.postUrl || null,
                      post_author: post.author || null,
                      ai_score: e.score,
                      ai_reason: (e.reason || '').slice(0, 500),
                      is_ad_opportunity: e.ad_opportunity === true,
                      ad_reason: (e.ad_reason || '').slice(0, 500) || null,
                      comment_angle: (e.comment_angle || '').slice(0, 500) || null,
                      language: e.comment_language || groupLanguage || 'vi',
                      is_ad_post: isAdPost,
                      swarm_target: swarmTarget,
                    })
                  }
                  if (rows.length) {
                    await supabase.from('shared_posts')
                      .upsert(rows, { onConflict: 'post_fb_id', ignoreDuplicates: true })
                    console.log(`[NURTURE] 🐝 Pooled ${rows.length} shared_posts (swarm targets: ${rows.map(r => r.swarm_target).join(',')})`)
                  }
                } catch (poolErr) {
                  console.warn(`[NURTURE] shared_posts upsert failed: ${poolErr.message}`)
                }
              } else {
                console.log(`[NURTURE] AI Brain says NO posts worth engaging in "${group.name}" (topic: ${topic})`)
                result.errors.push(`ai_eval: 0/${eligible.length} posts scored >= 5`)
                logger.log('ai_evaluate_posts', {
                  target_type: 'group', target_name: group.name, result_status: 'skipped',
                  details: { total_eligible: eligible.length, selected: 0, reason: 'no_relevant_posts' },
                })
              }
            } catch (err) {
              console.warn(`[NURTURE] AI Brain evaluation failed: ${err.message}, falling back to simple selection`)
              result.errors.push(`ai_eval_error: ${err.message}`)
              // Fallback: take first N eligible posts
              aiSelected = eligible.slice(0, maxComments)
            }
          }

          commentDebug.ai_selected = aiSelected.length

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

              let thisPostFbId = null
              if (thisPostUrl) {
                const m = thisPostUrl.match(/(?:posts|permalink)\/(\d+)/) || thisPostUrl.match(/story_fbid=(\d+)/) || thisPostUrl.match(/\/(\d{10,})/)
                if (m) thisPostFbId = m[1]
              }

              // 1. Permanent deduplication across owner's accounts
              if (thisPostFbId && commentedPostIds.has(thisPostFbId)) {
                console.log(`[NURTURE] Skip post ${thisPostFbId} — already commented by this or another nick permanently`)
                continue
              }

              // 2. Swarm Cooldown: skip if another nick commented in the last 60 minutes
              if (thisPostUrl && recentCommentedUrls.has(thisPostUrl)) {
                console.log(`[NURTURE] Skip post ${thisPostUrl} — recently commented by another nick (60m swarm cooldown)`)
                continue
              }
              if (thisPostFbId && recentCommentedPostIds.has(thisPostFbId)) {
                console.log(`[NURTURE] Skip post ID ${thisPostFbId} — recently commented by another nick (60m swarm cooldown)`)
                continue
              }

              commentDebug.attempted++
              // Try data-attribute first (fast), then re-find by searching articles for matching post
              let commentBtn = await page.$(`[data-nurture-comment="${post.index}"]`)
              if (!commentBtn && post.postUrl) {
                // FB may have re-rendered DOM — find article containing this post's URL, then find comment button
                commentBtn = await page.evaluate((postUrl) => {
                  const findCmtBtn = (art) => {
                    const modernBtn = art.querySelector('[data-ad-rendering-role="comment_button"]')
                    if (modernBtn) {
                      let clickTarget = modernBtn
                      for (let i = 0; i < 4 && clickTarget; i++) {
                        if (clickTarget.getAttribute && (
                            clickTarget.getAttribute('role') === 'button' ||
                            clickTarget.tagName === 'BUTTON' ||
                            clickTarget.tagName === 'A' ||
                            clickTarget.getAttribute('tabindex') === '0'
                        )) return clickTarget
                        clickTarget = clickTarget.parentElement
                      }
                      return modernBtn
                    }
                    const ariaBtns = art.querySelectorAll('[role="button"][aria-label*="bình luận" i], [role="button"][aria-label*="comment" i], a[aria-label*="bình luận" i], a[aria-label*="comment" i], button[aria-label*="bình luận" i], button[aria-label*="comment" i]')
                    if (ariaBtns.length > 0) return ariaBtns[0]

                    const buttonsAndLinks = art.querySelectorAll('[role="button"], a, button, div[tabindex="0"]')
                    for (const btn of buttonsAndLinks) {
                      const label = (btn.getAttribute('aria-label') || '').toLowerCase()
                      const text = (btn.innerText || '').trim().toLowerCase()
                      const cleanText = text.replace(/[^a-z0-9\sđđăâêôơưưáàảãạđíìỉĩịóòỏõọúùủũụýỳỷỹỵ]/gi, '').trim()
                      if (label.includes('comment') || label.includes('bình luận') ||
                          cleanText.includes('bình luận') || cleanText.includes('comment') ||
                          cleanText.includes('leave a comment') || cleanText.includes('viết bình luận')) {
                        return btn
                      }
                    }
                    return null
                  }

                  // Scan all potential article containers (both [role="article"] and tagged article divs)
                  const articles = [
                    ...document.querySelectorAll('[role="article"]'),
                    ...document.querySelectorAll('[data-nurture-article]')
                  ]
                  const uniqueArticles = [...new Set(articles)]

                  for (const article of uniqueArticles) {
                    const parent = article.parentElement?.closest('[role="article"]') || article.parentElement?.closest('[data-nurture-article]')
                    if (parent && parent !== article) continue
                    
                    const postSuffix = postUrl.split('?')[0].split('/').pop()
                    const link = article.querySelector(`a[href*="${postSuffix}"]`) ||
                                 article.querySelector(`a[href*="${postUrl.substring(postUrl.length - 15)}"]`)
                    if (!link) continue

                    const btn = findCmtBtn(article)
                    if (btn) {
                      btn.setAttribute('data-nurture-refound', '1')
                      article.setAttribute('data-nurture-article-refound', '1') // Tag re-found article
                      return true
                    }
                  }
                  return false
                }, post.postUrl)
                if (commentBtn) commentBtn = await page.$('[data-nurture-refound="1"]')
              }
              if (!commentBtn) { commentDebug.no_box++; continue }

              // Post text already extracted during AI selection
              const postText = post.body || ''
              const postAuthor = post.author || ''

              // Final safety: skip if too short
              if (postText.length < 15) { continue }

              // Tag the active article container so we can scope selectors inside evaluate
              try {
                await commentBtn.evaluate((btn, postIndex) => {
                  const article = btn.closest('[role="article"]') ||
                    btn.closest('[data-nurture-article]') ||
                    document.querySelector(`[data-nurture-article="${postIndex}"]`) ||
                    document.querySelector('[data-nurture-article-refound="1"]')
                  if (article) {
                    // Clear any previous active tags first
                    document.querySelectorAll('[data-active-nurture]').forEach(el => el.removeAttribute('data-active-nurture'))
                    article.setAttribute('data-active-nurture', '1')
                  }
                }, post.index)
              } catch (tagErr) {
                console.warn(`[NURTURE] Failed tagging active article: ${tagErr.message}`)
              }

              await commentBtn.scrollIntoViewIfNeeded()
              await R.sleepRange(500, 1000)
              await commentBtn.click({ force: true, timeout: 5000 })
              await R.sleepRange(1500, 2500)

              // Find comment textbox (desktop contenteditable) - SCÓPED inside active article first
              let commentBox = null
              try {
                commentBox = await page.evaluateHandle(() => {
                  const activeArt = document.querySelector('[data-active-nurture="1"]')
                  if (!activeArt) return null
                  const SELS = [
                    'div[contenteditable="true"][role="textbox"][aria-label*="comment" i]',
                    'div[contenteditable="true"][role="textbox"][aria-label*="bình luận" i]',
                    'div[contenteditable="true"][role="textbox"]',
                  ]
                  for (const sel of SELS) {
                    const els = activeArt.querySelectorAll(sel)
                    for (const el of els) {
                      // Check visibility by checking offsets
                      if (el.offsetWidth > 0 && el.offsetHeight > 0) return el
                    }
                  }
                  return null
                })
                // Convert JSHandle to ElementHandle
                if (commentBox && !(await commentBox.asElement())) {
                  commentBox = null
                }
              } catch (scopedErr) {
                console.warn(`[NURTURE] Scoped commentBox lookup failed: ${scopedErr.message}`)
                commentBox = null
              }

              // Fallback to global visible comment box if scoped fails (backwards compatibility)
              if (!commentBox) {
                const desktopCommentSels = [
                  'div[contenteditable="true"][role="textbox"][aria-label*="comment" i]',
                  'div[contenteditable="true"][role="textbox"][aria-label*="bình luận" i]',
                  'div[contenteditable="true"][role="textbox"]',
                ]
                for (const sel of desktopCommentSels) {
                  try {
                    const els = await page.$$(sel)
                    for (const el of els) {
                      if (await el.isVisible().catch(() => false)) commentBox = el
                    }
                    if (commentBox) break
                  } catch {}
                }
              }

              if (!commentBox) {
                commentDebug.no_box++
                result.errors.push('comment: no comment box')
                
                // Cleanup tags on failure
                await page.evaluate(() => {
                  document.querySelectorAll('[data-active-nurture]').forEach(el => el.removeAttribute('data-active-nurture'))
                  document.querySelectorAll('[data-nurture-article-refound]').forEach(el => el.removeAttribute('data-nurture-article-refound'))
                }).catch(() => {})
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

                  // Extract specific matched product details if available
                  let matchedProduct = null
                  if (evaluation?.matched_product_name && Array.isArray(brandConfig.products)) {
                    matchedProduct = brandConfig.products.find(p => p && p.name && p.name.toLowerCase() === evaluation.matched_product_name.toLowerCase())
                  }

                  const oppResult = await generateOpportunityComment({
                    postContent: postText,
                    brandName: brandConfig.brand_name,
                    brandDescription: brandConfig.brand_description || '',
                    brandVoice: brandConfig.brand_voice || brandConfig.tone || 'thân thiện, tự nhiên',
                    commentAngle: evaluation?.comment_angle || '',
                    existingComments,
                    language: postLanguage,
                    userId: payload.owner_id,
                    accountId: account_id,
                    campaignId: campaign_id,
                    groupFbId: group?.fb_group_id || group?.id,
                    matchedProduct, // Pass matched sub-product/plan!
                  })
                  if (oppResult?.text && oppResult.text.length > 5) {
                    commentResult = oppResult
                    adTriggered = true
                    adCommentsToday++
                    console.log(`[NURTURE] 📢 Ad comment triggered by AI eval (score:${evaluation.score}, product:"${matchedProduct?.name || 'none'}", reason:"${(evaluation.ad_reason || '').substring(0, 60)}") — ad #${adCommentsToday}/${AD_COMMENT_DAILY_LIMIT}`)
                  }
                } catch (adErr) {
                  console.warn(`[NURTURE] Ad comment generation failed: ${adErr.message}, falling back to normal`)
                }
              }

              // Fix 2: pull thread comments captured during the post extraction step
              const postThreadComments = Array.isArray(post.threadComments) ? post.threadComments : []

              // Normal comment flow (if ad not triggered)
              if (!commentResult) {
                commentResult = await generateSmartComment({
                  postText, postAuthor,
                  group: { name: group.name, member_count: group.member_count },
                  campaign: campaignCtx,
                  nick: { username: account.username, created_at: account.created_at, mission: config?.nick_mission },
                  topic, commentAngle,
                  ownerId: payload.owner_id,
                  threadComments: postThreadComments, // Fix 2
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
                  accountId: account_id,
                  campaignId: campaign_id,
                  groupFbId: group?.fb_group_id || group?.id,
                })
              }

              const commentText = typeof commentResult === 'object' ? commentResult.text : commentResult
              const isAI = typeof commentResult === 'object' ? (commentResult.ai || commentResult.smart) : false

              if (!commentText || commentText.length <= 6) { commentDebug.gen_failed++; continue }

              // === QUALITY GATE: Check comment quality before posting ===
              // Phase 6 Fix 4: gate now considers thread comments — comment must address
              // the actual ongoing discussion, not just the post body.
              if (commentText && commentText.length > 6) {
                const gate = await qualityGateComment({
                  comment: commentText, postText,
                  threadComments: postThreadComments,
                  group: { name: group.name },
                  topic, nick: { username: account.username },
                  ownerId: payload.owner_id,
                })
                if (!gate.approved) {
                  commentDebug.quality_rejected++
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

              // PRE-LOG: Create comment_logs entry BEFORE posting (status='pending')
              // This ensures we have a record even if typing/submit crashes
              let commentLogId = null
              try {
                const { data: logEntry, error: logErr } = await supabase.from('comment_logs').insert({
                  owner_id: payload.owner_id || payload.created_by, account_id,
                  job_id: payload.job_id || null,
                  fb_post_id: fbPostId,
                  comment_text: commentText, source_name: group.name,
                  status: 'pending', campaign_id,
                  ai_generated: isAI,
                  post_url: thisUrl,
                }).select('id').single()
                if (logErr) {
                  console.warn(`[NURTURE] Pre-log failed: ${logErr.message} — posting anyway`)
                } else {
                  commentLogId = logEntry?.id
                }
              } catch (err) {
                console.warn(`[NURTURE] Pre-log exception: ${err.message} — posting anyway`)
              }

              // Add to dedup BEFORE posting (prevent double-comment even if crash)
              if (thisUrl) commentedUrls.add(thisUrl)
              if (fbPostId) commentedPostIds.add(fbPostId)

              // TYPE + SUBMIT comment
              // Use focus() scoped inside the active article container
              await page.evaluate(() => {
                const activeArt = document.querySelector('[data-active-nurture="1"]')
                const container = activeArt || document
                const el = container.querySelector('[data-nurture-comment-input="1"]') ||
                  container.querySelector('[contenteditable="true"][role="textbox"][aria-label*="Bình luận" i]') ||
                  container.querySelector('[contenteditable="true"][role="textbox"][aria-label*="comment" i]') ||
                  container.querySelector('[contenteditable="true"]')
                if (el) {
                  el.scrollIntoView({ block: 'center' })
                  el.focus()
                  // Place cursor inside contenteditable so keyboard.type appends
                  const sel = window.getSelection()
                  const range = document.createRange()
                  range.selectNodeContents(el)
                  range.collapse(false)
                  sel.removeAllRanges()
                  sel.addRange(range)
                }
              })
              await R.sleepRange(500, 1000)
              for (const char of commentText) {
                await page.keyboard.type(char, { delay: Math.random() * 80 + 30 })
              }
              await R.sleepRange(800, 1500)
              await page.keyboard.press('Enter')
              await R.sleepRange(2500, 4500)

              // Submit button fallback: if Enter failed to post and text is still there, click Submit icon
              try {
                const commentSubmitted = await page.evaluate(() => {
                  const activeArt = document.querySelector('[data-active-nurture="1"]')
                  if (!activeArt) return false
                  const input = activeArt.querySelector('[contenteditable="true"]')
                  if (input && input.innerText.trim().length > 0) {
                    // Find submit button inside this article's comment area
                    const submitBtn = activeArt.querySelector('div[role="button"][aria-label*="bình luận" i]') ||
                      activeArt.querySelector('div[role="button"][aria-label*="comment" i]') ||
                      activeArt.querySelector('div[role="button"][aria-label*="post" i]') ||
                      activeArt.querySelector('div[role="button"][aria-label*="gửi" i]') ||
                      activeArt.querySelector('form button[type="submit"]') ||
                      activeArt.querySelector('div[role="button"]:has(svg)')
                    if (submitBtn) {
                      submitBtn.click()
                      return true
                    }
                  }
                  return false
                })
                if (commentSubmitted) {
                  console.log(`[NURTURE] Pressed Enter failed, fell back to clicking submit button inside article`)
                  await R.sleepRange(2000, 4000)
                }
              } catch (subErr) {
                console.warn(`[NURTURE] Submit fallback failed: ${subErr.message}`)
              }

              // POST-SUCCESS: Update log status + increment counters
              totalComments++
              tracker.increment('comment')
              result.comments_done++
              commented++

              // Update comment_logs status to 'done'
              if (commentLogId) {
                try { await supabase.from('comment_logs').update({ status: 'done', finished_at: new Date().toISOString() }).eq('id', commentLogId) } catch {}
              }

              // Increment budget (separate try/catch — don't crash if this fails)
              try { await supabase.rpc('increment_budget', { p_account_id: account_id, p_action_type: 'comment' }) } catch {}

              // Mark post as commented in group_post_scores (for scan-based flow)
              if (fbPostId) {
                try { await supabase.from('group_post_scores').update({ commented: true, commented_at: new Date().toISOString() })
                  .eq('fb_post_id', fbPostId).eq('owner_id', payload.owner_id || payload.created_by) } catch {}
              }

              const isSoftAd = adTriggered || (hasAdOpportunity && brandConfig?.brand_name && (commentText || '').toLowerCase().includes((brandConfig.brand_name || '').toLowerCase()))
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
              if (commentLogId) {
                try { await supabase.from('comment_logs').update({ status: 'failed', error_message: err.message, finished_at: new Date().toISOString() }).eq('id', commentLogId) } catch {}
              }
              logger.log('comment', { target_type: 'group', target_name: group.name, result_status: 'failed', details: { error: err.message } })
            } finally {
              // Cleanup tags on DOM
              await page.evaluate(() => {
                document.querySelectorAll('[data-active-nurture]').forEach(el => el.removeAttribute('data-active-nurture'))
                document.querySelectorAll('[data-nurture-article-refound]').forEach(el => el.removeAttribute('data-nurture-article-refound'))
              }).catch(() => {})
            }
          }
        }

        // === SEEDING NHẸ: comment ngắn khi group AI = 'observe' + post match topic ===
        // Khi nhóm chỉ ở chế độ 'observe' (like only), nếu có bài viết chứa topic
        // keywords → vẫn để 1 comment tự nhiên ngắn. Không cần AI eval / quality gate.
        if (result.aiDecision?.action === 'observe' && topic &&
            commentCheck.allowed && tracker.get('comment') < maxCommentsSession &&
            result.comments_done === 0) {
          try {
            const seedKws = (topic || '').toLowerCase().split(/[\s,]+/).filter(k => k.length > 2)
            const SEED_TEMPLATES = [
              'Hay đó bạn!', 'Chia sẻ hay lắm nha', 'Topic này mình cũng quan tâm',
              'Cảm ơn bạn đã chia sẻ', 'Hay ghê, cảm ơn bạn', 'Bài viết hay quá!',
              'Mình cũng đang tìm hiểu vấn đề này', 'Hay lắm bạn ơi',
            ]
            const seedPosts = await page.evaluate((kws) => {
              const results = []
              for (const article of [...document.querySelectorAll('[role="article"]')].slice(0, 15)) {
                const parent = article.parentElement?.closest('[role="article"]')
                if (parent && parent !== article) continue
                let body = ''
                for (const d of article.querySelectorAll('div[dir="auto"]')) {
                  const t = (d.innerText || '').trim()
                  if (t.length > body.length && t.length < 2000 && !d.closest('[role="group"]')) body = t
                }
                if (body.length < 15) continue
                const lower = body.toLowerCase()
                if (!kws.some(kw => lower.includes(kw))) continue
                let hasCommentBtn = false
                const toolbar = article.querySelector('[role="group"]') || article
                for (const btn of toolbar.querySelectorAll('[role="button"], a')) {
                  const l = (btn.getAttribute('aria-label') || '').toLowerCase()
                  const t2 = (btn.innerText || '').trim().toLowerCase()
                  if (l.includes('comment') || l.includes('bình luận') || /^(comment|bình luận)$/i.test(t2)) {
                    btn.setAttribute('data-seed-idx', results.length)
                    hasCommentBtn = true; break
                  }
                }
                let postUrl = null
                for (const lnk of article.querySelectorAll('a[href*="/posts/"], a[href*="/permalink/"], a[href*="story_fbid"]')) {
                  const href = lnk.href || ''
                  if (href.match(/\/(posts|permalink)\//) || href.includes('story_fbid')) { postUrl = href.split('?')[0]; break }
                }
                results.push({ index: results.length, body: body.substring(0, 200), postUrl, hasCommentBtn })
              }
              return results
            }, seedKws).catch(() => [])

            const seedCandidates = seedPosts
              .filter(p => p.hasCommentBtn && (!p.postUrl || !commentedUrls.has(p.postUrl)))
              .slice(0, 1)

            for (const seedPost of seedCandidates) {
              try {
                const commentBtn = await page.$(`[data-seed-idx="${seedPost.index}"]`)
                if (!commentBtn) continue
                const seedText = SEED_TEMPLATES[Math.floor(Math.random() * SEED_TEMPLATES.length)]
                await commentBtn.scrollIntoViewIfNeeded()
                await R.sleepRange(500, 1200)
                await commentBtn.click({ force: true, timeout: 5000 })
                await R.sleepRange(1200, 2500)
                let commentBox = null
                for (const sel of [
                  'div[contenteditable="true"][role="textbox"][aria-label*="comment" i]',
                  'div[contenteditable="true"][role="textbox"][aria-label*="bình luận" i]',
                  'div[contenteditable="true"][role="textbox"]',
                ]) {
                  const el = await page.$(sel)
                  if (el && await el.isVisible().catch(() => false)) { commentBox = el; break }
                }
                if (!commentBox) continue
                // 2026-05-02: same focus-via-evaluate trick as main comment block
                await page.evaluate(() => {
                  const el = document.querySelector('div[contenteditable="true"][role="textbox"][aria-label*="bình luận" i]') ||
                    document.querySelector('div[contenteditable="true"][role="textbox"][aria-label*="comment" i]') ||
                    document.querySelector('div[contenteditable="true"][role="textbox"]')
                  if (el) {
                    el.scrollIntoView({ block: 'center' })
                    el.focus()
                    const sel = window.getSelection()
                    const range = document.createRange()
                    range.selectNodeContents(el)
                    range.collapse(false)
                    sel.removeAllRanges()
                    sel.addRange(range)
                  }
                })
                await R.sleepRange(300, 600)
                for (const char of seedText) {
                  await page.keyboard.type(char, { delay: Math.random() * 70 + 25 })
                }
                await R.sleepRange(600, 1200)
                await page.keyboard.press('Enter')
                await R.sleepRange(1500, 3000)
                totalComments++
                tracker.increment('comment')
                result.comments_done++
                if (seedPost.postUrl) commentedUrls.add(seedPost.postUrl)
                try { await supabase.rpc('increment_budget', { p_account_id: account_id, p_action_type: 'comment' }) } catch {}
                logger.log('comment', {
                  target_type: 'group', target_id: group.fb_group_id, target_name: group.name,
                  details: { comment_text: seedText, seeding_light: true, observe_mode: true, topic_match: true },
                })
                console.log(`[NURTURE] 🌱 Seeding nhẹ: "${seedText}" → "${group.name}" (topic match, observe mode)`)
                await R.sleepRange(30000, 60000)
              } catch (seedErr) {
                console.warn(`[NURTURE] Seeding nhẹ comment failed: ${seedErr.message}`)
              }
            }
            if (seedCandidates.length === 0) {
              console.log(`[NURTURE] Seeding nhẹ: no topic-matched posts found in "${group.name}"`)
            }
          } catch (seedErr) {
            console.warn(`[NURTURE] Seeding nhẹ scan failed: ${seedErr.message}`)
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

      // Phase 2: re-score group after visit and persist tier
      try {
        const { scoreGroup } = require('../../lib/ai-brain')
        const liked = result.likes_done || 0
        const commented = result.comments_done || 0
        const memberCount = group.member_count || 1
        const engagementRate = (liked + commented) / Math.max(1, memberCount)
        const postsPerDay = (result.posts_seen || result.eligible_posts || 0)
        const topicRelevance = group.ai_join_score || group.ai_relevance?.score || 5
        const langMatch = !group.language || campaignLanguage === 'mixed' || group.language === campaignLanguage
        const { score, tier } = scoreGroup({
          engagementRate, postsPerDay, topicRelevance, languageMatch: langMatch,
        })
        const yieldedAnything = (liked + commented) > 0
        const update = {
          score_tier: tier,
          engagement_rate: engagementRate,
          last_scored_at: new Date().toISOString(),
          total_interactions: (group.total_interactions || 0) + liked + commented,
          consecutive_skips: yieldedAnything ? 0 : ((group.consecutive_skips || 0) + 1),
        }
        if (yieldedAnything) update.last_yield_at = new Date().toISOString()
        await supabase.from('fb_groups').update(update)
          .eq('fb_group_id', group.fb_group_id).eq('account_id', account_id)
        // Phase 9: mirror score/tier + last_nurtured_at into campaign_groups junction
        if (group._junction_id) {
          try {
            await supabase.from('campaign_groups').update({
              score, tier, last_nurtured_at: new Date().toISOString(),
            }).eq('id', group._junction_id)
          } catch {}
        } else if (campaign_id && group.id) {
          try {
            await supabase.from('campaign_groups').update({
              score, tier, last_nurtured_at: new Date().toISOString(),
            }).eq('campaign_id', campaign_id).eq('group_id', group.id)
          } catch {}
        }
        console.log(`[NURTURE] 📊 ${group.name}: score=${score} tier=${tier} (eng=${engagementRate.toFixed(4)}, skips=${update.consecutive_skips})`)
      } catch (scErr) {
        console.warn(`[NURTURE] scoreGroup failed: ${scErr.message}`)
      }

      // 2026-05-02: flush activity log per-group so we get visibility while
      // the session is still running (default flush only at handler end =
      // invisible until job finishes, which can be 10+ min for 10 groups).
      try { await logger.flush() } catch {}

      // 2026-05-02: continue across groups — don't break on first comment.
      // Hermes evaluatePosts already filters by campaign target so each group
      // visit is purposeful work. Only stop when daily session budget hits
      // (maxCommentsSession check above already handles that). User wants
      // throughput: visit all 10 selected groups, accumulate likes/comments.
      // Break early ONLY if session-level budget is fully consumed.
      if (tracker.get('comment') >= maxCommentsSession && tracker.get('like') >= maxLikesSession) {
        console.log(`[NURTURE] Session budget fully consumed (comments=${tracker.get('comment')}/${maxCommentsSession}, likes=${tracker.get('like')}/${maxLikesSession}), stopping`)
        break
      }
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

    // ══════════════════════════════════════════════════════════
    // Phase 19: AI-driven continuous operation — post-session decision
    // AI decides: when to run next, what to do, based on actual performance.
    // ══════════════════════════════════════════════════════════
    try {
      // Gather context for AI
      const { data: kpiRow } = await supabase.from('nick_kpi_daily')
        .select('target_likes, done_likes, target_comments, done_comments, kpi_met')
        .eq('campaign_id', campaign_id).eq('account_id', account_id)
        .eq('date', new Date().toISOString().split('T')[0]).maybeSingle()

      const { count: groupsAvailable } = await supabase.from('campaign_groups')
        .select('id', { count: 'exact', head: true })
        .eq('campaign_id', campaign_id).eq('assigned_nick_id', account_id)
        .eq('status', 'active')
      const { count: groupsPending } = await supabase.from('fb_groups')
        .select('id', { count: 'exact', head: true })
        .eq('account_id', account_id).eq('pending_approval', true).eq('is_member', false)

      const vnHour = new Date(Date.now() + 7 * 3600000).getUTCHours()
      const skipReasons = groupResults.map(g => g.skip_reason).filter(Boolean)

      const sessionCtx = {
        groups_visited: groupResults.length,
        likes: totalLikes,
        comments: totalComments,
        duration_seconds: duration,
        skip_reasons: [...new Set(skipReasons)],
        groups_available: groupsAvailable || 0,
        groups_pending: groupsPending || 0,
        kpi: {
          likes_done: kpiRow?.done_likes || 0, likes_target: kpiRow?.target_likes || 0,
          comments_done: kpiRow?.done_comments || 0, comments_target: kpiRow?.target_comments || 0,
          met: kpiRow?.kpi_met || false,
        },
      }

      const axios = require('axios')
      const API_URL = process.env.API_URL || 'http://localhost:3000'
      const AUTH_TOKEN = process.env.AGENT_SECRET_KEY || process.env.AGENT_USER_TOKEN || ''

      let decision = null
      try {
        const res = await axios.post(`${API_URL}/ai/generate`, {
          function_name: 'ai_pilot',
          messages: [{ role: 'user', content: `Nick "${account.username}" vừa xong nurture session:
Groups: ${sessionCtx.groups_visited} | Likes: ${sessionCtx.likes} | Comments: ${sessionCtx.comments} | Duration: ${duration}s
Skip reasons: ${sessionCtx.skip_reasons.join(', ') || 'none'}
KPI: likes ${sessionCtx.kpi.likes_done}/${sessionCtx.kpi.likes_target}, comments ${sessionCtx.kpi.comments_done}/${sessionCtx.kpi.comments_target}${sessionCtx.kpi.met ? ' (MET)' : ''}
Groups available: ${sessionCtx.groups_available} | Pending: ${sessionCtx.groups_pending}
Giờ VN: ${vnHour}h | Nick age: ${getNickAgeDays(account)}d | Status: ${account.status}

Quyết định next actions (JSON):
{"next_nurture_minutes":45,"do_feed_browse":true,"feed_browse_minutes":20,"check_pending_groups":false,"scout_new_groups":false,"rest_reason":null,"reasoning":"giải thích ngắn"}

Hướng dẫn: KPI gần đạt→tăng interval. Nhiều skip→ưu tiên scout. 0 comments→check groups. Ngoài 6-23h→rest. Nick<21d→rest.
Chỉ trả JSON.` }],
          max_tokens: 200, temperature: 0.1,
        }, {
          timeout: 10000,
          headers: { 'Content-Type': 'application/json',
            ...(AUTH_TOKEN && { Authorization: `Bearer ${AUTH_TOKEN}` }),
            ...(payload.owner_id && { 'x-user-id': payload.owner_id }),
          },
        })
        const text = res.data?.text || res.data?.result || ''
        const m = String(text).match(/\{[\s\S]*\}/)
        if (m) decision = JSON.parse(m[0])
      } catch (aiErr) {
        console.warn(`[AI-OPS] post-session AI failed: ${aiErr.message}`)
      }

      // Fallback defaults
      if (!decision) {
        decision = {
          next_nurture_minutes: 45,
          do_feed_browse: true,
          feed_browse_minutes: 20,
          check_pending_groups: (groupsPending || 0) > 0,
          scout_new_groups: false, // 2026-05-28: DISABLED — never auto-discover groups
          rest_reason: null,
          reasoning: 'AI unavailable — defaults',
        }
      }

      // Apply decisions
      const now = Date.now()
      const jobsToCreate = []

      // Next nurture (if not resting and within active hours)
      if (!decision.rest_reason && vnHour >= 6 && vnHour < 23) {
        const nextAt = new Date(now + (decision.next_nurture_minutes || 45) * 60000)
        const { count: dupCount } = await supabase.from('jobs')
          .select('id', { count: 'exact', head: true })
          .eq('type', 'campaign_nurture')
          .in('status', ['pending', 'claimed', 'running'])
          .filter('payload->>campaign_id', 'eq', campaign_id)
          .filter('payload->>account_id', 'eq', account_id)
        if ((dupCount || 0) === 0) {
          jobsToCreate.push({
            type: 'campaign_nurture', priority: 3,
            payload: { ...payload, ai_scheduled: true, reason: decision.reasoning },
            status: 'pending', scheduled_at: nextAt.toISOString(),
            created_by: payload.owner_id,
          })
        }
      }

      // Feed browse
      if (decision.do_feed_browse) {
        jobsToCreate.push({
          type: 'nurture_feed', priority: 5,
          payload: { account_id, campaign_id, owner_id: payload.owner_id },
          status: 'pending',
          scheduled_at: new Date(now + (decision.feed_browse_minutes || 20) * 60000).toISOString(),
          created_by: payload.owner_id,
        })
      }

      // Check pending groups
      if (decision.check_pending_groups && (groupsPending || 0) > 0) {
        const { data: pGroups } = await supabase.from('fb_groups')
          .select('id, fb_group_id, name').eq('account_id', account_id)
          .eq('pending_approval', true).eq('is_member', false).limit(3)
        for (const g of pGroups || []) {
          jobsToCreate.push({
            type: 'check_group_membership', priority: 3,
            payload: { fb_group_id: g.fb_group_id, group_row_id: g.id, account_id, group_name: g.name, campaign_id, owner_id: payload.owner_id },
            status: 'pending',
            scheduled_at: new Date(now + 5 * 60000).toISOString(),
            created_by: payload.owner_id,
          })
        }
      }

      // Scout new groups — dedup per-nick (not just per-campaign) so each nick
      // independently discovers groups even when another nick already has a
      // scout job pending for the same campaign.
      // 2026-05-28: DISABLED — scout_new_groups completely removed.
      // The agent NEVER auto-discovers or joins new groups.
      // Only groups manually added by the user to campaign_groups are used.

      if (jobsToCreate.length) {
        await supabase.from('jobs').insert(jobsToCreate)
        console.log(`[AI-OPS] Scheduled ${jobsToCreate.length} follow-ups: ${decision.reasoning}`)
      }

      // Log decision for ops learning
      await supabase.from('campaign_activity_log').insert({
        campaign_id, account_id, owner_id: payload.owner_id,
        action_type: 'ai_next_action',
        result_status: decision.rest_reason ? 'skipped' : 'success',
        details: { decision, session: sessionCtx, jobs_scheduled: jobsToCreate.length },
      }).then(() => {}, () => {})

    } catch (opsErr) {
      console.warn(`[AI-OPS] post-session decision failed: ${opsErr.message}`)
    }

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
