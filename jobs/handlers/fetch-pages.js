const { getPage, releaseSession } = require('../../browser/session-pool')
const { delay, humanScrollToBottom, humanBrowse, humanMouseMove } = require('../../browser/human')
const path = require('path')
const fs = require('fs')

// System paths không phải page vanity slug
const SYSTEM_PATHS = new Set([
  'pages', 'groups', 'settings', 'help', 'login', 'signup', 'events',
  'marketplace', 'watch', 'gaming', 'bookmarks', 'messages', 'notifications',
  'friends', 'photos', 'videos', 'stories', 'reels', 'profile.php', 'hashtag',
  'search', 'feeds', 'discover', 'joins', 'create', 'feed', 'people', 'ads',
  'business', 'privacy', 'policies', 'recover', 'checkpoint', 'composer',
])

/**
 * Kiểm tra ID hợp lệ: numeric ID (8+ digits) HOẶC vanity slug
 * Cả 2 format đều là ID hợp lệ cho pages
 */
function isValidIdentifier(id) {
  if (!id) return false
  if (id.startsWith('slug:')) return false
  if (/^\d{5,}$/.test(id)) return true
  if (/^[a-zA-Z][a-zA-Z0-9._-]{1,49}$/.test(id) && !SYSTEM_PATHS.has(id.toLowerCase())) return true
  return false
}

// ─────────────────────────────────────────────────────────────────
// SYSTEM PAGE BLACKLIST
// ─────────────────────────────────────────────────────────────────

const SYSTEM_PAGE_PATTERNS = [
  /tải thông tin/i, /upload.*contact/i, /lựa chọn quảng cáo/i, /ad\s*choice/i,
  /đối tượng không phải người dùng/i, /non.?user/i,
  /^privacy/i, /^quyền riêng tư/i, /^điều khoản/i, /^terms/i,
  /^facebook/i, /^meta\s/i, /^messenger/i, /^instagram/i,
  /^help\s*center/i, /^trung tâm trợ giúp/i, /^about/i, /^giới thiệu/i,
  /^settings/i, /^cài đặt/i, /^log\s*in/i, /^đăng nhập/i, /^sign\s*up/i,
  /^create/i, /^tạo/i, /^page\s*\d+$/i,
  /^quảng cáo$/i, /^advertise$/i, /^ads?$/i, /^boost/i,
  /^tạo bài viết$/i, /^create post$/i, /^create a post$/i,
  /^tin nhắn$/i, /^message$/i, /^messages$/i,
  /^thông báo$/i, /^notification/i,
  /^xem thêm$/i, /^see more$/i, /^view more$/i,
  /^thích$/i, /^like$/i, /^follow$/i, /^theo dõi$/i,
]

function isSystemPage(name) {
  if (!name || name.length < 2 || name.length > 200) return true
  return SYSTEM_PAGE_PATTERNS.some(pat => pat.test(name.trim()))
}

function decodeUnicode(str) {
  if (!str) return str
  return str.replace(/\\u[\dA-Fa-f]{4}/g, m => String.fromCharCode(parseInt(m.slice(2), 16)))
}

// ─────────────────────────────────────────────────────────────────
// EXTRACTION (shared logic with fetch-all.js)
// ─────────────────────────────────────────────────────────────────

function extractPagesFromResponse(text, collected) {
  try {
    const json = JSON.parse(text)
    walkJson(json, (obj) => {
      if (obj && typeof obj === 'object') {
        const id = obj.id || obj.pageID || obj.page_id
        if (!id || !/^\d{5,}$/.test(String(id))) return
        const isPage = obj.__typename === 'Page'
          || obj.page_id || obj.pageID
          || obj.fan_count !== undefined
          || obj.category_name || obj.page_url
        if (!isPage) return
        if (obj.name && isSystemPage(obj.name)) return

        const entry = collected.get(String(id)) || { fb_page_id: String(id) }
        if (obj.name) entry.name = obj.name
        if (obj.category_name) entry.category = obj.category_name
        if (obj.category) entry.category = entry.category || obj.category
        if (obj.fan_count != null) entry.fan_count = Number(obj.fan_count)
        if (obj.followers_count != null) entry.fan_count = entry.fan_count || Number(obj.followers_count)
        collected.set(String(id), entry)
      }
    })
  } catch {
    // JSON parse fail → regex fallback
    for (const m of text.matchAll(/\{[^{}]{0,3000}?"(?:pageID|id)"\s*:\s*"(\d{8,})"[^{}]{0,3000}?\}/g)) {
      const block = m[0], id = m[1]
      if (!block.includes('"Page"') && !block.includes('"pageID"')) continue
      const entry = collected.get(id) || { fb_page_id: id }
      const nameMatch = block.match(/"name"\s*:\s*"([^"]{2,150})"/)
      if (nameMatch) {
        if (isSystemPage(nameMatch[1])) continue
        entry.name = nameMatch[1]
      }
      const catMatch = block.match(/"category_name"\s*:\s*"([^"]+)"/)
      if (catMatch) entry.category = catMatch[1]
      const fanMatch = block.match(/"(?:fan_count|followers_count|like_count)"\s*:\s*(\d+)/)
      if (fanMatch) entry.fan_count = parseInt(fanMatch[1])
      collected.set(id, entry)
    }
  }
}

function walkJson(obj, fn, depth = 0) {
  if (depth > 15) return
  if (obj === null || obj === undefined) return
  if (typeof obj === 'object') {
    fn(obj)
    if (Array.isArray(obj)) {
      for (const item of obj) walkJson(item, fn, depth + 1)
    } else {
      for (const val of Object.values(obj)) walkJson(val, fn, depth + 1)
    }
  }
}

/** DOM extraction — 4 strategies (same as fetch-all.js) */
async function extractPagesFromDOM(page) {
  return page.evaluate(() => {
    const results = []
    const seen = new Set()

    const sysPatterns = [
      /tải thông tin/i, /upload.*contact/i, /lựa chọn quảng cáo/i, /ad\s*choice/i,
      /đối tượng không phải người dùng/i, /non.?user/i,
      /^privacy/i, /^quyền riêng tư/i, /^điều khoản/i, /^terms/i,
      /^facebook/i, /^meta\s/i, /^messenger/i, /^instagram/i,
      /^help\s*center/i, /^trung tâm trợ giúp/i, /^about/i, /^giới thiệu/i,
      /^settings/i, /^cài đặt/i, /^log\s*in/i, /^đăng nhập/i, /^sign\s*up/i,
      /^create/i, /^tạo/i, /^page\s*\d+$/i,
      /^quảng cáo$/i, /^advertise$/i, /^ads?$/i, /^boost/i,
      /^tạo bài viết$/i, /^create post$/i, /^create a post$/i,
      /^tin nhắn$/i, /^message$/i, /^messages$/i,
      /^thông báo$/i, /^notification/i,
      /^xem thêm$/i, /^see more$/i, /^view more$/i,
      /^thích$/i, /^like$/i, /^follow$/i, /^theo dõi$/i,
    ]
    function isSys(name) {
      if (!name || name.length < 2 || name.length > 200) return true
      return sysPatterns.some(p => p.test(name.trim()))
    }
    function addPage(id, name, extra = {}) {
      if (!id || seen.has(id)) return false
      if (name && isSys(name)) return false
      seen.add(id)
      results.push({ fb_page_id: id, name: name || null, ...extra })
      return true
    }

    // 3a: Scan <script> tags for page data
    for (const script of document.querySelectorAll('script')) {
      const text = script.textContent || ''
      if (text.length < 100 || text.length > 1000000) continue
      if (!text.includes('pageID') && !text.includes('"Page"')
        && !text.includes('page_id') && !text.includes('category_name')) continue
      for (const m of text.matchAll(/\{[^{}]{0,3000}?"(?:pageID|id)"\s*:\s*"(\d{8,})"[^{}]{0,3000}?\}/g)) {
        const id = m[1], block = m[0]
        if (!block.includes('"Page"') && !block.includes('"pageID"') && !block.includes('"page_id"')) continue
        const nameMatch = block.match(/"name"\s*:\s*"([^"]{2,150})"/)
        const catMatch = block.match(/"category_name"\s*:\s*"([^"]+)"/)
        const fanMatch = block.match(/"(?:fan_count|followers_count)"\s*:\s*(\d+)/)
        addPage(id, nameMatch?.[1], {
          category: catMatch?.[1] || null,
          fan_count: fanMatch ? parseInt(fanMatch[1]) : null,
        })
      }
    }

    // 3b: Embedded JSON in [role="main"] innerHTML
    const mainContent = document.querySelector('[role="main"]') || document.body
    const mainHTML = mainContent.innerHTML
    for (const m of mainHTML.matchAll(/\{[^{}]{0,3000}?"(?:pageID|id)"\s*:\s*"(\d{8,})"[^{}]{0,3000}?\}/g)) {
      const id = m[1], block = m[0]
      if (!block.includes('"Page"') && !block.includes('"pageID"')) continue
      const nameMatch = block.match(/"name"\s*:\s*"([^"]{2,150})"/)
      const catMatch = block.match(/"category_name"\s*:\s*"([^"]+)"/)
      const fanMatch = block.match(/"(?:fan_count|followers_count)"\s*:\s*(\d+)/)
      addPage(id, nameMatch?.[1], {
        category: catMatch?.[1] || null,
        fan_count: fanMatch ? parseInt(fanMatch[1]) : null,
      })
    }

    // 3c: Visual page links with numeric ID
    // Skip links có textContent trống (avatar, icon) — tránh add page với name=null rồi block link có tên thật
    for (const link of mainContent.querySelectorAll('a[href]')) {
      const href = link.getAttribute('href') || ''
      const idMatch = href.match(/\/(?:pages\/[^/]+\/|.*-)(\d{8,})\/?(?:\?|$)/)
        || href.match(/\/(\d{8,})\/?(?:\?|$)/)
        || href.match(/page_id=(\d{8,})/)
        || href.match(/[?&]id=(\d{8,})/)
      if (!idMatch) continue
      const name = link.textContent?.trim()?.split('\n')[0]?.trim()
      if (!name || name.length < 2) continue
      addPage(idMatch[1], name)
    }

    // 3d: Page card detection — tìm cards có nút "Tạo bài viết"
    const createBtnTexts = ['tạo bài viết', 'create post', 'create a post']
    const allElements = mainContent.querySelectorAll('span, a, div[role="button"]')
    for (const el of allElements) {
      const text = el.textContent?.trim()?.toLowerCase()
      if (!text || !createBtnTexts.some(t => text === t)) continue

      let container = el.parentElement
      for (let i = 0; i < 10 && container && container !== mainContent; i++) {
        const links = container.querySelectorAll('a[href]')
        if (links.length >= 2) break
        container = container.parentElement
      }
      if (!container || container === mainContent) continue

      const cardLinks = container.querySelectorAll('a[href]')
      let pageId = null, pageName = null
      for (const link of cardLinks) {
        const href = link.getAttribute('href') || ''
        const linkText = link.textContent?.trim()?.split('\n')[0]?.trim()
        if (linkText && createBtnTexts.includes(linkText.toLowerCase())) continue
        if (linkText && /^quảng cáo$|^advertise$/i.test(linkText)) continue

        const idMatch = href.match(/\/(\d{8,})\/?/) || href.match(/page_id=(\d{8,})/) || href.match(/[?&]id=(\d{8,})/)
        if (idMatch) pageId = idMatch[1]
        if (!pageName && linkText && linkText.length >= 2 && linkText.length <= 200) pageName = linkText
      }

      if (!pageId) {
        const imgs = container.querySelectorAll('img[src]')
        for (const img of imgs) {
          const src = img.getAttribute('src') || ''
          const imgId = src.match(/\/p(\d{8,})\//) || src.match(/\/(\d{8,})_/)
          if (imgId) { pageId = imgId[1]; break }
        }
      }

      if (!pageId) {
        for (const link of cardLinks) {
          const href = link.getAttribute('href') || ''
          const linkText = link.textContent?.trim()?.split('\n')[0]?.trim()
          if (linkText && createBtnTexts.includes(linkText.toLowerCase())) continue
          if (linkText && /^quảng cáo$|^advertise$/i.test(linkText)) continue
          const slugMatch = href.match(/^https?:\/\/(?:www\.)?facebook\.com\/([a-zA-Z0-9._-]{2,50})\/?$/)
            || href.match(/^\/([a-zA-Z0-9._-]{2,50})\/?$/)
          if (slugMatch && pageName) {
            pageId = `slug:${slugMatch[1]}`
            break
          }
        }
      }

      if (pageId && pageName) addPage(pageId, pageName)
    }

    return results
  })
}

// ─────────────────────────────────────────────────────────────────
// MAIN HANDLER
// ─────────────────────────────────────────────────────────────────

async function fetchPagesHandler(payload, supabase) {
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

    console.log(`[FETCH-PAGES] Fetching pages for ${account.username || account_id}...`)

    const urls = [
      'https://www.facebook.com/pages/?category=your_pages',
      'https://www.facebook.com/pages/?category=your_pages&ref=bookmarks',
      'https://www.facebook.com/bookmarks/pages',
    ]

    const collected = new Map()
    let graphqlStats = { total: 0, matched: 0, errors: 0 }

    // Network interception — bắt GraphQL responses chứa page data
    const responseHandler = async (response) => {
      try {
        const url = response.url()
        if (!url.includes('/api/graphql') && !url.includes('graphql')) return
        graphqlStats.total++
        const ct = response.headers()['content-type'] || ''
        if (!ct.includes('json') && !ct.includes('text') && !ct.includes('javascript')) return
        const text = await response.text().catch(() => { graphqlStats.errors++; return '' })
        if (!text || text.length < 50) return
        if (text.includes('"Page"') || text.includes('"pageID"')
          || text.includes('"fan_count"') || text.includes('"category_name"')
          || text.includes('"page_id"') || text.includes('"page_admin"')
          || text.includes('"managed_page"') || text.includes('"ownerID"')
          || text.includes('"pages_tab"') || text.includes('"your_pages"')) {
          graphqlStats.matched++
          extractPagesFromResponse(text, collected)
        }
      } catch {}
    }
    page.on('response', responseHandler)

    for (const url of urls) {
      console.log(`[FETCH-PAGES] Trying URL: ${url}`)
      try {
        // Dùng 'load' + waitForFunction — đợi content render
        await page.goto(url, { waitUntil: 'load', timeout: 30000 })
        await page.waitForFunction(() => {
          const main = document.querySelector('[role="main"]')
          if (!main) return false
          return main.querySelectorAll('a[href]').length >= 3
        }, { timeout: 15000 }).catch(() => {
          console.log(`[FETCH-PAGES] Warning: main content chưa load sau 15s`)
        })
        await delay(3000, 5000)

        // Giả lập browse trang
        await humanBrowse(page, 3)

        // DOM extraction trước scroll
        const domPages = await extractPagesFromDOM(page)
        for (const p of domPages) {
          if (p.fb_page_id && !collected.has(p.fb_page_id)) collected.set(p.fb_page_id, p)
        }

        console.log(`[FETCH-PAGES] GraphQL: ${graphqlStats.total} responses, ${graphqlStats.matched} matched`)
        console.log(`[FETCH-PAGES] After initial extract: ${collected.size} pages`)

        // Scroll chậm đến hết trang
        // onBeforeCheck chạy TRƯỚC height check → detect data mới → reset no-change counter
        let scrollExtractCount = 0
        let lastScrollSize = collected.size
        await humanScrollToBottom(page, {
          maxScrolls: 300,
          onBeforeCheck: async (count) => {
            // DOM extraction — bắt page cards mới rendered qua scroll
            const domExtra = await extractPagesFromDOM(page)
            for (const p of domExtra) {
              if (p.fb_page_id && !collected.has(p.fb_page_id)) {
                collected.set(p.fb_page_id, p)
                scrollExtractCount++
              }
            }

            // Click "Xem thêm" / "See more" nếu có — FB dùng load-more button
            const clickedMore = await page.evaluate(() => {
              const main = document.querySelector('[role="main"]') || document.body
              const moreTexts = ['xem thêm', 'see more', 'load more', 'tải thêm']
              for (const btn of main.querySelectorAll('div[role="button"]')) {
                if (btn.dataset.__sfClicked) continue
                const text = btn.textContent?.trim()?.toLowerCase()
                if (text && moreTexts.includes(text)) {
                  const rect = btn.getBoundingClientRect()
                  if (rect.height > 0 && rect.width > 0) {
                    btn.dataset.__sfClicked = '1'
                    btn.click()
                    return true
                  }
                }
              }
              for (const span of main.querySelectorAll('div[role="button"] span')) {
                if (span.closest('div[role="button"]')?.dataset?.__sfClicked) continue
                const text = span.textContent?.trim()?.toLowerCase()
                if (text && moreTexts.includes(text)) {
                  const rect = span.getBoundingClientRect()
                  if (rect.height > 0 && rect.width > 0) {
                    const parentBtn = span.closest('div[role="button"]')
                    if (parentBtn) parentBtn.dataset.__sfClicked = '1'
                    span.click()
                    return true
                  }
                }
              }
              return false
            })
            if (clickedMore) {
              console.log(`[FETCH-PAGES] Clicked "load more" button`)
              await delay(3000, 5000)
              const domMore = await extractPagesFromDOM(page)
              for (const p of domMore) {
                if (p.fb_page_id && !collected.has(p.fb_page_id)) {
                  collected.set(p.fb_page_id, p)
                  scrollExtractCount++
                }
              }
            }

            // Return true nếu có data mới → reset no-change counter
            const hasNew = collected.size > lastScrollSize
            lastScrollSize = collected.size
            return hasNew
          },
          onScroll: async (count) => {
            if (count % 20 === 0) console.log(`[FETCH-PAGES] Scrolled ${count} times, found ${collected.size} pages`)
          }
        })

        // Extract again after scroll
        const domAfterScroll = await extractPagesFromDOM(page)
        for (const p of domAfterScroll) {
          if (p.fb_page_id && !collected.has(p.fb_page_id)) collected.set(p.fb_page_id, p)
        }

        console.log(`[FETCH-PAGES] Found ${collected.size} pages from ${url} (${scrollExtractCount} from scroll)`)
        // KHÔNG break — tiếp tục thử URL khác để accumulate thêm pages

      } catch (err) {
        console.log(`[FETCH-PAGES] URL failed: ${url} - ${err.message}`)
      }
    }
    page.removeListener('response', responseHandler)

    // Debug dump if 0 pages
    if (collected.size === 0) {
      console.log('[FETCH-PAGES] No pages found, saving diagnostics...')
      try {
        const debugDir = path.join(__dirname, '..', '..', 'debug')
        if (!fs.existsSync(debugDir)) fs.mkdirSync(debugDir, { recursive: true })
        const ts = Date.now()
        await page.screenshot({ path: path.join(debugDir, `fetch-pages-standalone-${ts}.png`), fullPage: false })

        const diagnostics = await page.evaluate(() => {
          const main = document.querySelector('[role="main"]')
          const allLinks = main ? [...main.querySelectorAll('a[href]')] : []
          return {
            url: window.location.href,
            hasMain: !!main,
            mainTextLength: main?.innerText?.length || 0,
            mainLinksCount: allLinks.length,
            sampleLinks: allLinks.slice(0, 30).map(l => ({
              href: (l.getAttribute('href') || '').substring(0, 200),
              text: (l.textContent?.trim() || '').substring(0, 80),
            })),
            bodyTextSample: (document.body?.innerText || '').substring(0, 2000),
          }
        })
        console.log(`[FETCH-PAGES] DIAGNOSTICS:`)
        console.log(`  URL: ${diagnostics.url}, Has main: ${diagnostics.hasMain}`)
        console.log(`  Main links: ${diagnostics.mainLinksCount}, Text length: ${diagnostics.mainTextLength}`)
        console.log(`  GraphQL: ${graphqlStats.total} total, ${graphqlStats.matched} matched, ${graphqlStats.errors} errors`)
        for (const l of diagnostics.sampleLinks.slice(0, 10)) {
          console.log(`  ${l.text.substring(0, 40)} → ${l.href.substring(0, 80)}`)
        }
        fs.writeFileSync(path.join(debugDir, `fetch-pages-diag-${ts}.json`), JSON.stringify(diagnostics, null, 2))
      } catch (debugErr) {
        console.log('[FETCH-PAGES] Debug save failed:', debugErr.message)
      }
    }

    // Resolve vanity slugs
    const slugEntries = [...collected.entries()].filter(([id]) => id.startsWith('slug:'))
    if (slugEntries.length > 0) {
      console.log(`[FETCH-PAGES] Resolving ${slugEntries.length} vanity slugs...`)
      for (const [slugId, entry] of slugEntries) {
        try {
          const slug = slugId.replace('slug:', '')
          let numericId = null

          // ═══ GraphQL interception — bắt pageID từ responses khi navigate ═══
          const slugHandler = async (response) => {
            try {
              if (numericId) return
              const rUrl = response.url()
              if (!rUrl.includes('graphql')) return
              const text = await response.text().catch(() => '')
              if (!text || text.length < 50) return
              const m = text.match(/"pageID"\s*:\s*"(\d{8,})"/)
                || text.match(/"page_id"\s*:\s*"(\d{8,})"/)
                || text.match(/"id"\s*:\s*"(\d{8,})"[^{}]{0,200}?"__typename"\s*:\s*"Page"/)
                || text.match(/"ownerID"\s*:\s*"(\d{8,})"/)
                || text.match(/"profile_id"\s*:\s*"(\d{8,})"/)
                || text.match(/"entity_id"\s*:\s*"(\d{8,})"/)
              if (m) numericId = m[1]
            } catch {}
          }
          page.on('response', slugHandler)

          await page.goto(`https://www.facebook.com/${slug}/`, { waitUntil: 'load', timeout: 20000 })
          await delay(4000, 6000)
          page.removeListener('response', slugHandler)

          // Fallback 1: Check redirect URL
          if (!numericId) {
            const currentUrl = page.url()
            const urlIdMatch = currentUrl.match(/[?&]id=(\d{8,})/) || currentUrl.match(/\/(\d{8,})\/?(?:\?|$)/)
            if (urlIdMatch) numericId = urlIdMatch[1]
          }

          // Fallback 2: HTML parsing
          if (!numericId) {
            numericId = await page.evaluate(() => {
              const url = window.location.href
              const urlId = url.match(/[?&]id=(\d{8,})/) || url.match(/\/(\d{8,})\/?(?:\?|$)/)
              if (urlId) return urlId[1]

              const ogUrl = document.querySelector('meta[property="al:android:url"]')?.content
              const m1 = ogUrl?.match(/page\/(\d+)/)
              if (m1) return m1[1]
              const ogPage = document.querySelector('meta[property="og:url"]')?.content
              const m2 = ogPage?.match(/\/(\d{8,})\/?$/)
              if (m2) return m2[1]
              const canonical = document.querySelector('link[rel="canonical"]')?.href
              const m2b = canonical?.match(/\/(\d{8,})\/?$/)
              if (m2b) return m2b[1]

              for (const meta of document.querySelectorAll('meta[content]')) {
                const mc = meta.content?.match(/(?:page|entity)[/.](\d{8,})/)
                if (mc) return mc[1]
              }

              const src = document.documentElement.innerHTML.substring(0, 500000)
              const m3 = src.match(/"pageID"\s*:\s*"(\d{8,})"/)
                || src.match(/"page_id"\s*:\s*"(\d{8,})"/)
                || src.match(/"id"\s*:\s*"(\d{8,})"[^{}]{0,200}?"__typename"\s*:\s*"Page"/)
                || src.match(/"ownerID"\s*:\s*"(\d{8,})"/)
                || src.match(/"profile_id"\s*:\s*"(\d{8,})"/)
                || src.match(/"entity_id"\s*:\s*"(\d{8,})"/)
                || src.match(/"userID"\s*:\s*"(\d{8,})"/)
              return m3?.[1] || null
            })
          }

          if (numericId && !collected.has(numericId)) {
            collected.delete(slugId)
            entry.fb_page_id = numericId
            collected.set(numericId, entry)
            console.log(`[FETCH-PAGES] Resolved: ${slug} → ${numericId}`)
          } else if (numericId) {
            // numeric ID đã tồn tại → xóa slug entry
            collected.delete(slugId)
            console.log(`[FETCH-PAGES] Slug ${slug} → ${numericId} (already exists)`)
          } else {
            // Không resolve được → giữ vanity slug làm ID hợp lệ
            collected.delete(slugId)
            entry.fb_page_id = slug
            collected.set(slug, entry)
            const finalUrl = page.url()
            console.log(`[FETCH-PAGES] Keeping vanity slug as ID: ${slug} (URL: ${finalUrl.substring(0, 100)})`)
          }
        } catch (err) {
          // Lỗi resolution → giữ vanity slug thay vì drop
          const slug = slugId.replace('slug:', '')
          collected.delete(slugId)
          entry.fb_page_id = slug
          collected.set(slug, entry)
          console.log(`[FETCH-PAGES] Slug resolution error, keeping vanity: ${slug} - ${err.message}`)
        }
      }
    }

    // Filter to valid IDs (numeric hoặc vanity slug) + decode unicode
    const decoded = [...collected.values()]
      .filter(p => p.fb_page_id && isValidIdentifier(p.fb_page_id))
      .map(p => ({
        ...p,
        name: decodeUnicode(p.name) || `Page ${p.fb_page_id}`,
        category: decodeUnicode(p.category),
      }))

    console.log(`[FETCH-PAGES] Total unique pages: ${decoded.length}`)

    // Visit từng page để lấy metadata (category, fan_count) nếu chưa có
    const pagesNeedMeta = decoded.filter(p => !p.category && !p.fan_count)
    if (pagesNeedMeta.length > 0) {
      console.log(`[FETCH-PAGES] Fetching metadata for ${pagesNeedMeta.length} pages...`)
      for (let i = 0; i < pagesNeedMeta.length; i++) {
        const p = pagesNeedMeta[i]
        try {
          await page.goto(`https://www.facebook.com/${p.fb_page_id}`, {
            waitUntil: 'domcontentloaded', timeout: 20000
          })
          await delay(2000, 4000)
          await humanMouseMove(page)

          const meta = await page.evaluate(() => {
            const text = document.body.innerText || ''
            let category = null, fan_count = null

            const countPats = [
              /(\d[\d.,]*[KkMm]?)\s*(?:followers|người theo dõi)/i,
              /(\d[\d.,]*[KkMm]?)\s*(?:likes|lượt thích)/i,
            ]
            for (const pat of countPats) {
              const match = text.match(pat)
              if (match) {
                let num = match[1].replace(/\./g, '').replace(/,/g, '')
                if (num.match(/[Kk]$/)) num = parseFloat(num) * 1000
                else if (num.match(/[Mm]$/)) num = parseFloat(num) * 1000000
                fan_count = Math.round(Number(num))
                if (!isNaN(fan_count) && fan_count > 0) break
                fan_count = null
              }
            }

            const src = document.documentElement.innerHTML.substring(0, 200000)
            const catMatch = src.match(/"category_name"\s*:\s*"([^"]+)"/)
              || src.match(/"category"\s*:\s*"([^"]+)"/)
            if (catMatch) category = catMatch[1]

            return { category, fan_count }
          })

          Object.assign(p, meta)
          if ((i + 1) % 10 === 0) console.log(`[FETCH-PAGES] Metadata: ${i + 1}/${pagesNeedMeta.length}`)
          await delay(3000, 7000)
        } catch (err) {
          console.log(`[FETCH-PAGES] Skip metadata for ${p.fb_page_id}: ${err.message}`)
          await delay(2000, 4000)
        }
      }
    }

    // Cleanup browser
    await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {})
    await page.close().catch(() => {})
    releaseSession(account_id)

    // Upsert pages vào DB
    let added = 0
    for (const p of decoded) {
      const { error } = await supabase.from('fanpages').upsert({
        account_id,
        fb_page_id: p.fb_page_id,
        name: p.name,
        url: `https://www.facebook.com/${p.fb_page_id}`,
        ...(p.category && { category: p.category }),
        ...(p.fan_count && { fan_count: p.fan_count }),
      }, { onConflict: 'account_id,fb_page_id' })
      if (!error) added++
      else console.log(`[FETCH-PAGES] DB error for ${p.fb_page_id}:`, error.message)
    }

    console.log(`[FETCH-PAGES] Saved ${added} pages to DB`)

    // Cleanup: xoá stale pages
    const fetchedIds = decoded.map(p => p.fb_page_id)
    const { data: existing } = await supabase
      .from('fanpages')
      .select('id, fb_page_id')
      .eq('account_id', account_id)
    const stale = (existing || []).filter(e => !fetchedIds.includes(e.fb_page_id))
    if (stale.length > 0) {
      const { error: delErr } = await supabase.from('fanpages').delete().in('id', stale.map(s => s.id))
      if (!delErr) console.log(`[FETCH-PAGES] Cleaned ${stale.length} stale pages`)
      else console.log(`[FETCH-PAGES] Cleanup error:`, delErr.message)
    }

    return { pages_found: decoded.length, pages_saved: added }
  } catch (err) {
    console.error(`[FETCH-PAGES] Error:`, err.message)
    if (page) await page.close().catch(() => {})
    releaseSession(account_id)
    throw err
  }
}

module.exports = fetchPagesHandler
