const { getPage, releaseSession } = require('../../browser/session-pool')
const { delay, humanScrollToBottom, humanBrowse, humanMouseMove } = require('../../browser/human')

async function fetchGroupsHandler(payload, supabase) {
  const { account_id } = payload

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

    // Navigate to groups page
    console.log(`[FETCH-GROUPS] Fetching groups for ${account.username || account_id}...`)
    await page.goto('https://www.facebook.com/groups/joins', { waitUntil: 'domcontentloaded', timeout: 30000 })
    await delay(3000, 5000)

    // Giả lập browse trang vài giây trước khi scroll
    await humanBrowse(page, 3)

    // Scroll chậm đến hết trang
    const scrollCount = await humanScrollToBottom(page, {
      maxScrolls: 300,
      onScroll: (count) => {
        if (count % 20 === 0) console.log(`[FETCH-GROUPS] Scrolled ${count} times...`)
      }
    })

    // Extract groups từ DOM
    const groups = await page.evaluate(() => {
      const src = document.documentElement.innerHTML
      const results = []

      // System paths trong /groups/ — không phải group vanity slug
      const groupSystemPaths = new Set([
        'joins', 'discover', 'feed', 'create', 'search', 'notifications',
        'settings', 'your_groups', 'suggested', 'browse', 'new',
      ])

      // Strategy 1: Parse group links from DOM
      const links = document.querySelectorAll('a[href*="/groups/"]')
      const seen = new Set()
      for (const link of links) {
        const href = link.getAttribute('href')

        // Ưu tiên numeric ID
        const idMatch = href?.match(/\/groups\/(\d+)/)
        if (idMatch && !seen.has(idMatch[1])) {
          seen.add(idMatch[1])
          const name = link.textContent?.trim()
          if (name && name.length > 1 && name.length < 150 && !name.includes('\n')) {
            results.push({ fb_group_id: idMatch[1], name })
          }
          continue
        }

        // Vanity slug groups: /groups/groupname
        if (!idMatch) {
          const slugMatch = href?.match(/\/groups\/([a-zA-Z][a-zA-Z0-9._-]{1,49})\/?(?:\?|$)/)
          if (slugMatch && !groupSystemPaths.has(slugMatch[1].toLowerCase()) && !seen.has(slugMatch[1])) {
            seen.add(slugMatch[1])
            const name = link.textContent?.trim()
            if (name && name.length > 1 && name.length < 150 && !name.includes('\n')) {
              results.push({ fb_group_id: slugMatch[1], name })
            }
          }
        }
      }

      // Strategy 2: GraphQL group data
      if (results.length === 0) {
        const gqlMatches = src.matchAll(/"groupID"\s*:\s*"(\d+)"[^}]*?"name"\s*:\s*"([^"]+)"/g)
        for (const m of gqlMatches) {
          if (!results.find(r => r.fb_group_id === m[1])) {
            results.push({ fb_group_id: m[1], name: m[2] })
          }
        }
      }

      // Strategy 3: JSON data format
      if (results.length === 0) {
        const jsonMatches = src.matchAll(/"id"\s*:\s*"(\d+)"[^}]*?"group_name"\s*:\s*"([^"]+)"/g)
        for (const m of jsonMatches) {
          results.push({ fb_group_id: m[1], name: m[2] })
        }
      }

      // Decode unicode
      return results.map(g => ({
        ...g,
        name: g.name.replace(/\\u[\dA-Fa-f]{4}/g, m => String.fromCharCode(parseInt(m.slice(2), 16)))
      }))
    })

    // Deduplicate
    const unique = [...new Map(groups.map(g => [g.fb_group_id, g])).values()]
    console.log(`[FETCH-GROUPS] Found ${unique.length} groups from list page`)

    // Visit từng group để lấy metadata (member_count, group_type)
    console.log(`[FETCH-GROUPS] Fetching metadata for each group...`)
    for (let i = 0; i < unique.length; i++) {
      const g = unique[i]
      try {
        await page.goto(`https://www.facebook.com/groups/${g.fb_group_id}`, {
          waitUntil: 'domcontentloaded',
          timeout: 20000
        })
        await delay(2000, 4000)

        // Giả lập đọc trang
        await humanMouseMove(page)
        await delay(1000, 2000)

        // Extract metadata từ trang group
        const meta = await page.evaluate(() => {
          const text = document.body.innerText || ''
          let member_count = null
          let group_type = null

          // Parse member count: "1.2K members", "10,5K thành viên", "123 members", "1,234 thành viên"
          const memberPatterns = [
            /(\d[\d.,]*[KkMm]?)\s*(?:members|thành viên|participants)/i,
            /(?:members|thành viên|participants)\s*[·•]\s*(\d[\d.,]*[KkMm]?)/i,
          ]
          for (const pat of memberPatterns) {
            const match = text.match(pat)
            if (match) {
              let num = match[1].replace(/\./g, '').replace(/,/g, '')
              if (num.match(/[Kk]$/)) num = parseFloat(num) * 1000
              else if (num.match(/[Mm]$/)) num = parseFloat(num) * 1000000
              member_count = Math.round(Number(num))
              if (!isNaN(member_count) && member_count > 0) break
              member_count = null
            }
          }

          // Parse group type
          if (/(?:Public group|Nhóm công khai)/i.test(text)) {
            group_type = 'public'
          } else if (/(?:Private group|Nhóm riêng tư)/i.test(text)) {
            group_type = 'closed'
          }

          return { member_count, group_type }
        })

        unique[i] = { ...g, ...meta }

        if ((i + 1) % 10 === 0) {
          console.log(`[FETCH-GROUPS] Metadata: ${i + 1}/${unique.length}`)
        }

        // Delay giữa các group (3-7s)
        await delay(3000, 7000)

      } catch (err) {
        console.log(`[FETCH-GROUPS] Skip metadata for ${g.fb_group_id}: ${err.message}`)
        await delay(2000, 4000)
      }
    }

    // Quay về trang chủ để trông tự nhiên
    await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {})
    await delay(1000, 3000)

    // Đóng tab nhưng KHÔNG đóng browser
    // Keep page on FB for session reuse
    releaseSession(account_id)

    // Upsert groups vào DB
    let added = 0
    for (const g of unique) {
      const { error } = await supabase.from('fb_groups').upsert({
        account_id,
        fb_group_id: g.fb_group_id,
        name: g.name,
        url: `https://www.facebook.com/groups/${g.fb_group_id}`,
        ...(g.member_count && { member_count: g.member_count }),
        ...(g.group_type && { group_type: g.group_type }),
      }, { onConflict: 'account_id,fb_group_id' })
      if (!error) added++
    }

    console.log(`[FETCH-GROUPS] Saved ${added} groups to DB`)

    // Cleanup: xoá các nhóm cũ không còn trong lần fetch mới
    if (unique.length > 0) {
      const fetchedIds = unique.map(g => g.fb_group_id)
      const { data: existing } = await supabase
        .from('fb_groups')
        .select('id, fb_group_id')
        .eq('account_id', account_id)
      const stale = (existing || []).filter(e => !fetchedIds.includes(e.fb_group_id))
      if (stale.length > 0) {
        const staleIds = stale.map(s => s.id)
        const { error: delErr } = await supabase.from('fb_groups').delete().in('id', staleIds)
        if (!delErr) console.log(`[FETCH-GROUPS] Cleaned ${stale.length} stale groups`)
        else console.log(`[FETCH-GROUPS] Cleanup error:`, delErr.message)
      }
    }

    return { groups_found: unique.length, groups_saved: added }
  } catch (err) {
    console.error(`[FETCH-GROUPS] Error:`, err.message)
    // Đóng tab nếu có lỗi, nhưng vẫn giữ browser
    // Keep page on FB for session reuse
    releaseSession(account_id)
    throw err
  }
}

module.exports = fetchGroupsHandler
