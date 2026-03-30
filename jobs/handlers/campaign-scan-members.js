/**
 * Campaign Handler: Scan Members (Role: scout)
 * Deep scan members of a specific group → feed target_queue
 */

const { getPage, releaseSession } = require('../../browser/session-pool')
const { humanScroll, humanMouseMove } = require('../../browser/human')
const { saveDebugScreenshot } = require('./post-utils')
const { checkHardLimit } = require('../../lib/hard-limits')
const R = require('../../lib/randomizer')

async function campaignScanMembers(payload, supabase) {
  const { account_id, campaign_id, role_id, config, feeds_into } = payload
  const groupUrl = config?.group_url
  const maxResults = config?.max_results || 50

  if (!groupUrl) throw new Error('SKIP_no_group_url')

  const { data: account } = await supabase
    .from('accounts')
    .select('*, proxies(*)')
    .eq('id', account_id)
    .single()
  if (!account) throw new Error('Account not found')

  // Check scan budget
  const budget = account.daily_budget?.scan || { used: 0, max: 10 }
  const { allowed } = checkHardLimit('scan', budget.used, 0)
  if (!allowed) throw new Error('SKIP_scan_budget_exceeded')

  let page
  try {
    const session = await getPage(account)
    page = session.page

    console.log(`[CAMPAIGN-SCAN] Scanning members of ${groupUrl}`)
    await page.goto(`${groupUrl}/members`, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await R.sleepRange(2000, 4000)

    // Get existing targets to avoid duplicates
    const { data: existingTargets } = await supabase
      .from('target_queue')
      .select('fb_user_id')
      .eq('campaign_id', campaign_id)
    const existingSet = new Set((existingTargets || []).map(t => t.fb_user_id))

    // Also check friend_request_log
    const { data: existingFR } = await supabase
      .from('friend_request_log')
      .select('target_fb_id')
      .eq('account_id', account_id)
    const frSet = new Set((existingFR || []).map(f => f.target_fb_id))

    // Scroll to load members
    const allMembers = []
    const seen = new Set()
    let noNewCount = 0

    for (let scroll = 0; scroll < 20 && allMembers.length < maxResults; scroll++) {
      await humanScroll(page)
      await R.sleepRange(1000, 2000)

      const newMembers = await page.evaluate(() => {
        const results = []
        // Try multiple selector patterns for member links
        const selectors = [
          'a[href*="/user/"]',
          'a[href*="/profile.php"]',
          'a[href*="facebook.com/"][role="link"]',
        ]
        for (const sel of selectors) {
          const links = document.querySelectorAll(sel)
          for (const link of links) {
            const href = link.href
            if (!href) continue
            const idMatch = href.match(/\/user\/(\d+)/) || href.match(/id=(\d+)/) || href.match(/facebook\.com\/(\d+)/)
            if (!idMatch) continue
            results.push({
              fb_user_id: idMatch[1],
              fb_user_name: link.textContent?.trim()?.substring(0, 80) || '',
              fb_profile_url: `https://www.facebook.com/profile.php?id=${idMatch[1]}`,
            })
          }
        }
        return results
      })

      let addedThisScroll = 0
      for (const m of newMembers) {
        if (seen.has(m.fb_user_id)) continue
        if (existingSet.has(m.fb_user_id)) continue
        if (frSet.has(m.fb_user_id)) continue
        seen.add(m.fb_user_id)
        allMembers.push(m)
        addedThisScroll++
      }

      if (addedThisScroll === 0) {
        noNewCount++
        if (noNewCount >= 3) break
      } else {
        noNewCount = 0
      }
    }

    // Extract group name from page
    const groupName = await page.evaluate(() => {
      const h1 = document.querySelector('h1')
      return h1?.textContent?.trim()?.substring(0, 100) || ''
    })

    // Insert to target_queue
    if (allMembers.length > 0 && feeds_into) {
      const rows = allMembers.slice(0, maxResults).map(m => ({
        campaign_id,
        source_role_id: role_id,
        target_role_id: feeds_into,
        fb_user_id: m.fb_user_id,
        fb_user_name: m.fb_user_name,
        fb_profile_url: m.fb_profile_url,
        source_group_name: groupName,
        active_score: 50 + Math.random() * 50,
        status: 'pending',
      }))

      await supabase.from('target_queue').upsert(rows, {
        onConflict: 'campaign_id,fb_user_id',
        ignoreDuplicates: true,
      })
    }

    // Increment scan budget
    await supabase.rpc('increment_budget', {
      p_account_id: account_id,
      p_action_type: 'scan',
    })

    console.log(`[CAMPAIGN-SCAN] Found ${allMembers.length} new members from ${groupName || groupUrl}`)
    return {
      success: true,
      members_found: allMembers.length,
      group_name: groupName,
      group_url: groupUrl,
    }
  } catch (err) {
    if (page) await saveDebugScreenshot(page, `campaign-scan-${account_id}`)
    throw err
  } finally {
    if (page) // Keep page on FB for session reuse
    releaseSession(account_id)
  }
}

module.exports = campaignScanMembers
