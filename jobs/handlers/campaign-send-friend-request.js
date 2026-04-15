/**
 * Campaign Handler: Send Friend Request (Role: connect)
 * Scan posts in labeled groups → find active users → AI eval → send friend request
 * No dependency on target_queue — self-contained.
 */

const { getPage, releaseSession } = require('../../browser/session-pool')
const { delay, humanScroll, humanMouseMove, humanClick } = require('../../browser/human')
const { saveDebugScreenshot } = require('./post-utils')
const { checkHardLimit, applyAgeFactor, getNickAgeDays } = require('../../lib/hard-limits')
const R = require('../../lib/randomizer')
const { getActionParams } = require('../../lib/plan-executor')
const { ActivityLogger } = require('../../lib/activity-logger')
const { evaluateLeadQuality } = require('../../lib/ai-brain')

async function campaignSendFriendRequest(payload, supabase) {
  const { account_id, campaign_id, role_id, parsed_plan, topic: rawTopic } = payload

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

  // Fetch campaign context for AI evaluation
  const { data: campaignData } = await supabase
    .from('campaigns')
    .select('name, topic, requirement')
    .eq('id', campaign_id)
    .single()
  const topic = rawTopic || campaignData?.topic || ''

  // Check budget
  const budget = account.daily_budget?.friend_request || { used: 0, max: 15 }
  const { allowed, remaining } = checkHardLimit('friend_request', budget.used, 0)
  if (!allowed || remaining <= 0) {
    throw new Error('SKIP_friend_request_budget_exceeded')
  }

  const nickAge = getNickAgeDays(account)
  const planFR = getActionParams(parsed_plan, 'friend_request', { countMin: 3, countMax: 5 }).count
  const maxFR = Math.min(applyAgeFactor(remaining, nickAge), planFR) // capped by plan + age factor

  // ── Find targets by scanning posts in labeled groups ──
  // Query labeled groups (same filter as nurture)
  const topicKeywords = topic.toLowerCase().split(/[\s,;]+/).filter(k => k.length > 1)

  const { data: labeledGroups } = await supabase.from('fb_groups')
    .select('id, fb_group_id, name, url, tags, topic, joined_via_campaign_id')
    .eq('account_id', account_id)
    .or('is_blocked.is.null,is_blocked.eq.false')
    .or('user_approved.is.null,user_approved.eq.true')

  const matchingGroups = (labeledGroups || []).filter(g => {
    const hasTags = g.tags?.some(tag => topicKeywords.some(kw => tag.includes(kw) || kw.includes(tag)))
    const hasTopic = g.topic && topicKeywords.some(kw => g.topic.toLowerCase().includes(kw))
    const hasCampaign = g.joined_via_campaign_id === campaign_id
    return hasTags || hasTopic || hasCampaign
  })

  if (!matchingGroups.length) {
    throw new Error('SKIP_no_labeled_groups — scout chưa join group nào cho campaign này')
  }

  // Pick 1-2 random groups to scan
  const shuffled = matchingGroups.sort(() => Math.random() - 0.5)
  const groupsToScan = shuffled.slice(0, Math.min(2, shuffled.length))
  console.log(`[CAMPAIGN-FR] Scanning ${groupsToScan.length} labeled groups for active users: ${groupsToScan.map(g => g.name).join(', ')}`)

  // Get already-sent friend requests for dedup
  const { data: existingFRs } = await supabase
    .from('friend_request_log')
    .select('target_fb_id')
    .eq('account_id', account_id)
    .limit(500)
  const sentFbIds = new Set((existingFRs || []).map(r => r.target_fb_id))

  let page
  try {
    const session = await getPage(account)
    page = session.page

    // Scan group posts to find active users (authors + commenters)
    const targets = []
    for (const group of groupsToScan) {
      try {
        const groupUrl = group.url || `https://www.facebook.com/groups/${group.fb_group_id}`
        await page.goto(groupUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })
        await R.sleepRange(2000, 4000)

        // Scroll to load more posts
        for (let i = 0; i < 3; i++) {
          await humanScroll(page)
          await R.sleepRange(1500, 3000)
        }

        // Extract post authors + active commenters from feed
        const activeUsers = await page.evaluate(() => {
          const users = []
          const seen = new Set()
          const articles = document.querySelectorAll('[role="article"]')

          for (const article of [...articles].slice(0, 15)) {
            // Skip nested (comment articles inside post articles)
            const parent = article.parentElement?.closest('[role="article"]')
            if (parent && parent !== article) continue

            // Post author
            const authorLink = article.querySelector('h2 a, h3 a, h4 a, a[role="link"] strong')
            const authorHref = authorLink?.closest('a')?.href || ''
            const authorIdMatch = authorHref.match(/\/user\/(\d+)/) || authorHref.match(/id=(\d+)/) || authorHref.match(/facebook\.com\/([a-zA-Z0-9.]+)/)
            if (authorIdMatch && !seen.has(authorIdMatch[1])) {
              seen.add(authorIdMatch[1])
              users.push({
                fb_user_id: authorIdMatch[1],
                fb_user_name: authorLink?.textContent?.trim()?.substring(0, 80) || '',
                fb_profile_url: authorHref.split('?')[0],
                source: 'post_author',
              })
            }

            // Commenters (people who engaged = higher quality targets)
            const commentLinks = article.querySelectorAll('ul a[role="link"], [data-sigil] a[role="link"]')
            for (const cLink of [...commentLinks].slice(0, 5)) {
              const cHref = cLink.href || ''
              const cIdMatch = cHref.match(/\/user\/(\d+)/) || cHref.match(/id=(\d+)/) || cHref.match(/facebook\.com\/([a-zA-Z0-9.]+)/)
              if (cIdMatch && !seen.has(cIdMatch[1])) {
                seen.add(cIdMatch[1])
                users.push({
                  fb_user_id: cIdMatch[1],
                  fb_user_name: cLink.textContent?.trim()?.substring(0, 80) || '',
                  fb_profile_url: cHref.split('?')[0],
                  source: 'commenter',
                })
              }
            }
          }
          return users.slice(0, 20)
        })

        // Filter out already-sent and own account
        const newUsers = activeUsers.filter(u =>
          u.fb_user_id !== account.fb_user_id &&
          !sentFbIds.has(u.fb_user_id) &&
          u.fb_user_id.length > 3
        )

        for (const u of newUsers) {
          u.source_group_name = group.name
          u.source_group_id = group.fb_group_id
          targets.push(u)
        }

        console.log(`[CAMPAIGN-FR] Group "${group.name}": found ${activeUsers.length} active users, ${newUsers.length} new (${sentFbIds.size} already sent)`)
        logger.log('scan', {
          target_type: 'group', target_name: group.name, target_id: group.fb_group_id,
          result_status: 'success',
          details: { active_users: activeUsers.length, new_targets: newUsers.length },
        })
      } catch (err) {
        console.warn(`[CAMPAIGN-FR] Failed to scan group ${group.name}: ${err.message}`)
      }
    }

    if (!targets.length) {
      throw new Error('SKIP_no_active_users_found — groups scanned but no new targets')
    }

    // Limit to maxFR targets
    const finalTargets = targets.slice(0, maxFR)
    console.log(`[CAMPAIGN-FR] ${finalTargets.length} targets to process (from ${targets.length} found)`)

    const results = []
    let sent = 0

    for (const target of finalTargets) {
      try {
        // Check if already sent
        const { data: existing } = await supabase
          .from('friend_request_log')
          .select('id, status')
          .eq('account_id', account_id)
          .eq('target_fb_id', target.fb_user_id)
          .single()

        if (existing) {
          // target_queue not used — targets from group post scanning
          results.push({ fb_user_id: target.fb_user_id, status: 'already_logged' })
          continue
        }

        // Skip targets AI-rejected (spam/competitor) in last 7 days by ANY nick
        const { data: recentReject } = await supabase
          .from('friend_request_log')
          .select('id, ai_type, ai_score')
          .eq('target_fb_id', target.fb_user_id)
          .eq('status', 'cancelled')
          .in('ai_type', ['spam', 'competitor'])
          .gte('created_at', new Date(Date.now() - 7 * 86400000).toISOString())
          .limit(1)
          .maybeSingle()

        if (recentReject) {
          // target_queue not used
          results.push({ fb_user_id: target.fb_user_id, status: 'ai_rejected_recent', ai_type: recentReject.ai_type })
          console.log(`[CAMPAIGN-FR] Skip ${target.fb_user_id} — AI rejected as ${recentReject.ai_type} within 7 days`)
          continue
        }

        // Navigate to profile
        const profileUrl = target.fb_profile_url || `https://www.facebook.com/profile.php?id=${target.fb_user_id}`
        console.log(`[CAMPAIGN-FR] Visiting profile: ${target.fb_user_name || target.fb_user_id}`)
        logger.log('visit_profile', { target_type: 'profile', target_id: target.fb_user_id, target_name: target.fb_user_name, target_url: profileUrl })
        const _frNavStart = Date.now()
        await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })
        const _frNavMs = Date.now() - _frNavStart
        await R.sleepRange(2000, 4000)
        await humanMouseMove(page)

        // Signal detection: slow load + redirect
        try {
          const signals = require('../../lib/signal-collector')
          signals.checkSlowLoad(account_id, payload.job_id, profileUrl, _frNavMs)
          signals.checkRedirectWarn(account_id, payload.job_id, profileUrl, page.url())
        } catch {}

        // Check if already friends
        const alreadyFriend = await page.$([
          'div[aria-label="Friends"]',
          'div[aria-label="Bạn bè"]',
          'a[aria-label="Friends"]',
        ].join(', '))

        if (alreadyFriend) {
          try { await supabase.from('friend_request_log').upsert({
            account_id, campaign_id,
            target_fb_id: target.fb_user_id, target_name: target.fb_user_name,
            target_profile_url: profileUrl, status: 'already_friend',
          }, { onConflict: 'account_id,target_fb_id' }) } catch {}
          // target_queue not used
          results.push({ fb_user_id: target.fb_user_id, status: 'already_friend' })
          try { await logger.log('friend_request', { target_type: 'profile', target_id: target.fb_user_id, target_name: target.fb_user_name, target_url: profileUrl, result_status: 'skipped', details: { reason: 'already_friend' } }) } catch {}
          continue
        }

        // Check if request already sent
        const pendingRequest = await page.$([
          'div[aria-label="Cancel request"]',
          'div[aria-label="Hủy yêu cầu"]',
          'div[aria-label="Request sent"]',
        ].join(', '))

        if (pendingRequest) {
          try { await supabase.from('friend_request_log').upsert({
            account_id, campaign_id,
            target_fb_id: target.fb_user_id, target_name: target.fb_user_name,
            target_profile_url: profileUrl, status: 'sent',
          }, { onConflict: 'account_id,target_fb_id' }) } catch {}
          // target_queue not used
          results.push({ fb_user_id: target.fb_user_id, status: 'already_sent' })
          try { await logger.log('friend_request', { target_type: 'profile', target_id: target.fb_user_id, target_name: target.fb_user_name, target_url: profileUrl, result_status: 'skipped', details: { reason: 'already_sent' } }) } catch {}
          continue
        }

        // === DEEP PROFILE SCAN + AI SCORING ===
        // Read profile like a real user: bio, intro, recent posts, mutual friends
        let aiEval = { score: 6, worth: true, type: 'unknown', reason: 'default' }
        let profileName = target.fb_user_name || ''
        let profileData = { name: '', bio: '', introItems: [], posts: [], mutualFriends: 0, friendCount: 0, isVerified: false }
        try {
          // Scroll profile naturally to load content
          await humanScroll(page)
          await R.sleepRange(1500, 3000)

          // Extract DEEP profile context
          profileData = await page.evaluate(() => {
            // Name from profile header
            const nameEl = document.querySelector('h1') || document.querySelector('[data-pagelet="ProfileActions"] + div h1')
            const name = nameEl?.textContent?.trim() || ''

            // Bio / intro text
            const bioEls = document.querySelectorAll('[data-pagelet="ProfileTilesFeed_0"] span[dir="auto"], [data-pagelet="IntroSection"] span')
            const bio = [...bioEls].map(el => el.textContent?.trim()).filter(t => t && t.length > 5 && t.length < 300).slice(0, 3).join(' | ')

            // Work / Education / Location from intro
            const introItems = [...document.querySelectorAll('[data-pagelet="IntroSection"] li, [data-pagelet="ProfileTilesFeed_0"] li')]
              .map(el => el.textContent?.trim()).filter(t => t && t.length > 3 && t.length < 150).slice(0, 5)

            // Recent posts (first 3 on profile)
            const posts = []
            const articles = document.querySelectorAll('[role="article"]')
            for (const art of [...articles].slice(0, 3)) {
              const parent = art.parentElement?.closest('[role="article"]')
              if (parent && parent !== art) continue
              let text = ''
              for (const d of art.querySelectorAll('div[dir="auto"]')) {
                const t = d.innerText?.trim() || ''
                if (t.length > text.length && t.length < 500) text = t
              }
              if (text.length > 10) posts.push(text.substring(0, 200))
            }

            // Mutual friends count
            const mutualEl = [...document.querySelectorAll('a, span')].find(el =>
              /bạn chung|mutual friend/i.test(el.textContent || ''))
            const mutualText = mutualEl?.textContent?.trim() || ''
            const mutualMatch = mutualText.match(/(\d+)\s*(bạn chung|mutual)/i)
            const mutualFriends = mutualMatch ? parseInt(mutualMatch[1]) : 0

            // Friend count (from profile header "X friends" or "X bạn bè")
            const friendCountEl = [...document.querySelectorAll('a, span')].find(el =>
              /^\d[\d.,]*\s*(bạn bè|friends)$/i.test(el.textContent?.trim() || ''))
            const friendCountText = friendCountEl?.textContent?.trim() || ''
            const friendCountMatch = friendCountText.match(/([\d.,]+)\s*(bạn bè|friends)/i)
            let friendCount = 0
            if (friendCountMatch) {
              friendCount = parseInt(friendCountMatch[1].replace(/[.,]/g, ''))
            }

            // Verified badge detection
            const isVerified = !!document.querySelector('[aria-label*="verified"], [aria-label*="Verified"], svg[aria-label*="xác minh"]')

            return { name, bio, introItems, posts, mutualFriends, friendCount, isVerified }
          }).catch(() => ({ name: '', bio: '', introItems: [], posts: [], mutualFriends: 0 }))

          // Update target name if we got it from profile
          if (profileData.name && !profileName) profileName = profileData.name

          // Build rich context for AI
          const contextParts = []
          if (profileData.name) contextParts.push(`Tên: ${profileData.name}`)
          if (profileData.bio) contextParts.push(`Bio: ${profileData.bio}`)
          if (profileData.introItems.length) contextParts.push(`Giới thiệu: ${profileData.introItems.join(', ')}`)
          if (profileData.posts.length) contextParts.push(`Bài gần đây: ${profileData.posts.join(' | ')}`)
          if (profileData.mutualFriends) contextParts.push(`Bạn chung: ${profileData.mutualFriends}`)
          if (profileData.friendCount) contextParts.push(`Số bạn bè: ${profileData.friendCount}`)
          if (profileData.isVerified) contextParts.push(`Verified: Có`)
          contextParts.push(`Nhóm nguồn: ${target.source_group_name || 'N/A'}`)

          const richContext = contextParts.join('\n')
          console.log(`[CAMPAIGN-FR] Profile scan: ${profileName || target.fb_user_id} — ${profileData.posts.length} posts, ${profileData.mutualFriends} mutual, bio: ${(profileData.bio || 'none').substring(0, 50)}`)

          aiEval = await evaluateLeadQuality({
            person: {
              name: profileName || target.fb_user_id,
              fb_user_id: target.fb_user_id,
              bio: profileData.bio,
              introItems: profileData.introItems,
              posts: profileData.posts,
              mutualFriends: profileData.mutualFriends,
              friendCount: profileData.friendCount,
              isVerified: profileData.isVerified,
            },
            postContext: richContext,
            campaign: campaignData,
            topic,
            ownerId: payload.owner_id,
          })

          console.log(`[CAMPAIGN-FR] AI eval: ${profileName || target.fb_user_id} → score:${aiEval.score} type:${aiEval.type} priority:${aiEval.priority || '?'} — ${aiEval.reason}`)

          // AI score logged to friend_request_log below (no target_queue dependency)

          // GATE: Only skip CONFIRMED spam/competitor (score < 3)
          if (aiEval.type === 'spam' || (aiEval.type === 'competitor' && aiEval.score < 3)) {
            console.log(`[CAMPAIGN-FR] ❌ SKIP ${profileName} — ${aiEval.type} (score: ${aiEval.score})`)
            try { await supabase.from('friend_request_log').upsert({
              account_id, campaign_id,
              target_fb_id: target.fb_user_id, target_name: profileName,
              target_profile_url: profileUrl, status: 'cancelled',
              ai_score: aiEval.score, ai_type: aiEval.type, ai_reason: (aiEval.reason || '').substring(0, 200),
            }, { onConflict: 'account_id,target_fb_id' }) } catch {}
            // target_queue not used
            results.push({ fb_user_id: target.fb_user_id, status: 'ai_rejected', ai_type: aiEval.type, score: aiEval.score })
            try { await logger.log('friend_request', {
              target_type: 'profile', target_id: target.fb_user_id, target_name: profileName,
              result_status: 'skipped', details: { reason: `rejected: ${aiEval.type}`, ai_score: aiEval.score },
            }) } catch {}
            continue
          }
        } catch (aiErr) {
          console.warn(`[CAMPAIGN-FR] Profile scan/AI eval failed: ${aiErr.message}, proceeding with default score`)
        }

        // GATE: Weighted scoring — mutual friends + AI score combined
        // Nick mới join group chưa có mutual, nên dùng AI score bù
        const mutual = profileData?.mutualFriends || 0
        const score = aiEval.score || 0
        let frAllowed = false
        let skipReason = ''

        if (mutual >= 3 && score >= 5) {
          frAllowed = true  // nhiều mutual compensate score thấp hơn
        } else if (mutual >= 1 && score >= 6) {
          frAllowed = true  // có mutual + score khá
        } else if (mutual === 0 && score >= 7) {
          frAllowed = true  // 0 mutual nhưng AI đánh giá rất tốt
        } else if (mutual === 0 && score < 5) {
          skipReason = 'no_mutual_low_score'
        } else {
          skipReason = 'insufficient_score_mutual'
        }

        if (!frAllowed) {
          console.log(`[CAMPAIGN-FR] ⚠️ SKIP ${profileName || target.fb_user_id} — mutual:${mutual}, score:${score} (${skipReason})`)
          results.push({ fb_user_id: target.fb_user_id, status: `skipped_${skipReason}`, score })
          try { await logger.log('friend_request', {
            target_type: 'profile', target_id: target.fb_user_id, target_name: profileName || target.fb_user_name,
            result_status: 'skipped', details: { reason: skipReason, mutual, ai_score: score },
          }) } catch {}
          continue
        }

        // Find Add Friend button
        const addBtn = await page.$([
          'div[aria-label="Add friend"]',
          'div[aria-label="Thêm bạn bè"]',
          'div[aria-label="Add Friend"]',
          'div[role="button"]:has-text("Add friend")',
          'div[role="button"]:has-text("Thêm bạn bè")',
          'div[role="button"]:has-text("Add Friend")',
        ].join(', '))

        if (addBtn) {
          // PRE-LOG: Record BEFORE clicking (status='sending') — prevents data loss if crash after click
          try {
            await supabase.from('friend_request_log').upsert({
              account_id, campaign_id,
              target_fb_id: target.fb_user_id,
              target_name: profileName || target.fb_user_name,
              target_profile_url: profileUrl,
              status: 'sending',
              ai_score: aiEval.score, ai_type: aiEval.type, ai_reason: (aiEval.reason || '').substring(0, 200),
            }, { onConflict: 'account_id,target_fb_id' })
          } catch (logErr) {
            console.warn(`[CAMPAIGN-FR] Pre-log failed: ${logErr.message}`)
          }

          // CLICK: Send friend request
          await humanScroll(page)
          await R.sleepRange(1000, 3000)
          await addBtn.scrollIntoViewIfNeeded()
          await R.sleepRange(500, 1500)
          await humanClick(page, addBtn)
          await R.sleepRange(1500, 3000)

          // POST-SUCCESS: Update status to 'sent'
          try {
            await supabase.from('friend_request_log').update({ status: 'sent' })
              .eq('account_id', account_id).eq('target_fb_id', target.fb_user_id)
          } catch {}

          // Create lead entry (separate try/catch — don't crash if this fails)
          try {
            await supabase.from('leads').upsert({
              owner_id: payload.owner_id || payload.created_by,
              fb_uid: target.fb_user_id,
              name: profileName || target.fb_user_name,
              platform: 'facebook',
              status: 'friend_sent',
              source: 'campaign_fr',
              source_detail: target.source_group_name || campaign_id,
              campaign_id,
              discovered_by: account_id,
              score: aiEval.score,
              ai_type: aiEval.type,
              ai_reason: (aiEval.reason || '').substring(0, 200),
              friend_sent_at: new Date().toISOString(),
            }, { onConflict: 'owner_id,fb_uid' })
          } catch (leadErr) {
            console.warn(`[CAMPAIGN-FR] Lead create failed: ${leadErr.message}`)
          }

          // Increment budget (separate try/catch)
          try { await supabase.rpc('increment_budget', { p_account_id: account_id, p_action_type: 'friend_request' }) } catch {}

          // Update target_queue (separate try/catch)
          // target_queue not used

          sent++
          results.push({ fb_user_id: target.fb_user_id, status: 'sent' })
          console.log(`[CAMPAIGN-FR] ✅ Sent request to: ${profileName || target.fb_user_id} (score: ${aiEval.score}, type: ${aiEval.type})`)
          try { await logger.log('friend_request', { target_type: 'profile', target_id: target.fb_user_id, target_name: profileName || target.fb_user_name, target_url: profileUrl, details: { status: 'sent', ai_score: aiEval.score, ai_type: aiEval.type, ai_reason: aiEval.reason } }) } catch {}

          // Remember: which prospect profile pattern the AI judged worth contacting
          try {
            const { remember } = require('../../lib/ai-memory')
            await remember(supabase, {
              campaignId: campaign_id,
              accountId: account_id,
              groupFbId: group?.fb_group_id || null,
              memoryType: 'nick_behavior',
              key: 'friend_request_sent_pattern',
              value: {
                ai_score: aiEval.score,
                ai_type: aiEval.type,
                ai_reason: (aiEval.reason || '').substring(0, 150),
                source_group: group?.name || null,
                has_mutual: !!target.mutualFriends,
              },
              confidence: Math.min(0.9, 0.4 + (aiEval.score || 5) * 0.06),
            })
          } catch (memErr) { /* non-blocking */ }
        } else {
          // No add button found
          results.push({ fb_user_id: target.fb_user_id, status: 'no_button' })
          try { await logger.log('friend_request', { target_type: 'profile', target_id: target.fb_user_id, target_name: target.fb_user_name, target_url: profileUrl, result_status: 'failed', details: { reason: 'no_add_button' } }) } catch {}
        }
      } catch (err) {
        console.warn(`[CAMPAIGN-FR] Failed for ${target.fb_user_id}: ${err.message}`)
        results.push({ fb_user_id: target.fb_user_id, status: 'failed', error: err.message })
        logger.log('friend_request', { target_type: 'profile', target_id: target.fb_user_id, target_name: target.fb_user_name, result_status: 'failed', details: { error: err.message } })
      }

      // Gap between friend requests (45-90s)
      if (finalTargets.indexOf(target) < finalTargets.length - 1) {
        const gap = R.friendRequestGap()
        console.log(`[CAMPAIGN-FR] Waiting ${Math.round(gap / 1000)}s`)
        await R.sleep(gap)
      }
    }

    console.log(`[CAMPAIGN-FR] Done: ${sent} requests sent out of ${finalTargets.length} targets`)
    return {
      success: true,
      targets_claimed: targets.length,
      requests_sent: sent,
      results,
    }
  } catch (err) {
    if (page) await saveDebugScreenshot(page, `campaign-fr-${account_id}`)
    throw err
  } finally {
    try { await logger.flush() } catch {}
    if (page) // Keep page on FB for session reuse
    await releaseSession(account_id, supabase)
  }
}

module.exports = campaignSendFriendRequest
