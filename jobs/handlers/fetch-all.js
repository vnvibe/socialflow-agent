const { getPage, releaseSession } = require('../../browser/session-pool')
const { delay, humanScroll, humanMouseMove } = require('../../browser/human')
const FacebookAPI = require('../../lib/fb-api')
const path = require('path')
const fs = require('fs')

const JOB_TIMEOUT_MS = 8 * 60 * 1000 // 8 phút max (groups cần thời gian scroll)
const NO_CHANGE_LIMIT = 5            // Dừng scroll nếu 5 lần không có data mới
const QUICK_BAIL_LIMIT = 2           // Chỉ thử 2 scrolls nếu initial load không có gì → skip URL
const SAVE_INTERVAL = 10             // Save incremental mỗi 10 scrolls

// System paths không phải page/group vanity slug
const SYSTEM_PATHS = new Set([
  'pages', 'groups', 'settings', 'help', 'login', 'signup', 'events',
  'marketplace', 'watch', 'gaming', 'bookmarks', 'messages', 'notifications',
  'friends', 'photos', 'videos', 'stories', 'reels', 'profile.php', 'hashtag',
  'search', 'feeds', 'discover', 'joins', 'create', 'feed', 'people', 'ads',
  'business', 'privacy', 'policies', 'recover', 'checkpoint', 'composer',
])

/**
 * Kiểm tra ID hợp lệ: numeric ID (5+ digits) HOẶC vanity slug
 * Cả 2 format đều là ID hợp lệ cho pages lẫn groups
 */
function isValidIdentifier(id) {
  if (!id) return false
  if (id.startsWith('slug:')) return false
  if (/^\d{5,}$/.test(id)) return true
  // Vanity slug: bắt đầu bằng chữ, 2-50 ký tự, không phải system path
  if (/^[a-zA-Z][a-zA-Z0-9._-]{1,49}$/.test(id) && !SYSTEM_PATHS.has(id.toLowerCase())) return true
  return false
}

function decodeUnicode(str) {
  if (!str) return str
  return str.replace(/\\u[\dA-Fa-f]{4}/g, m => String.fromCharCode(parseInt(m.slice(2), 16)))
}

/**
 * Check ngầm xem account có bị checkpoint/ban/session hết hạn không
 */
async function checkAccountStatus(page, supabase, account_id) {
  const { getBlockDetectionScript, reasonToStatus } = require('../../lib/block-detector')
  const status = await page.evaluate(getBlockDetectionScript())

  if (status.blocked) {
    console.log(`[CHECK] Account ${account_id} BLOCKED: ${status.reason} - ${status.detail}`)
    await supabase.from('accounts').update({
      status: reasonToStatus(status.reason),
    }).eq('id', account_id)
    try {
      const debugDir = path.join(__dirname, '..', '..', 'debug')
      if (!fs.existsSync(debugDir)) fs.mkdirSync(debugDir, { recursive: true })
      await page.screenshot({ path: path.join(debugDir, `blocked-${account_id}-${Date.now()}.png`), fullPage: false })
    } catch {}
  }

  return status
}

// ─────────────────────────────────────────────────────────────────
// SYSTEM PAGE BLACKLIST (shared giữa tất cả extraction layers)
// ─────────────────────────────────────────────────────────────────

const SYSTEM_PAGE_PATTERNS = [
  /tải thông tin/i, /upload.*contact/i, /lựa chọn quảng cáo/i, /ad\s*choice/i,
  /đối tượng không phải người dùng/i, /non.?user/i,
  /^privacy/i, /^quyền riêng tư/i, /^điều khoản/i, /^terms/i,
  /^facebook/i, /^meta\s/i, /^messenger/i, /^instagram/i,
  /^help\s*center/i, /^trung tâm trợ giúp/i, /^about/i, /^giới thiệu/i,
  /^settings/i, /^cài đặt/i, /^log\s*in/i, /^đăng nhập/i, /^sign\s*up/i,
  /^create/i, /^tạo/i, /^page\s*\d+$/i,
  // Button texts trên page cards — KHÔNG phải tên page
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

// ─────────────────────────────────────────────────────────────────
// PAGE EXTRACTION: 3 layers — GraphQL JSON > Regex fallback > Visual DOM
//
// Tất cả URLs ta dùng (your_pages, bookmarks/pages) đã lọc sẵn
// managed pages → KHÔNG cần check managed evidence.
// Chỉ cần: (1) trông giống Page, (2) không phải system text
// ─────────────────────────────────────────────────────────────────

/** Layer 1: Parse GraphQL JSON response — chất lượng cao nhất */
function extractPagesFromResponse(text, collected) {
  try {
    const json = JSON.parse(text)
    walkJson(json, (obj) => {
      if (obj && typeof obj === 'object') {
        const id = obj.id || obj.pageID || obj.page_id
        if (!id || !/^\d{5,}$/.test(String(id))) return
        // Phải trông giống Page object
        const isPage = obj.__typename === 'Page'
          || obj.page_id || obj.pageID
          || obj.fan_count !== undefined
          || obj.category_name
          || obj.page_url
        if (!isPage) return
        if (obj.name && isSystemPage(obj.name)) return

        const entry = collected.get(String(id)) || { fb_page_id: String(id) }
        if (obj.name) entry.name = obj.name
        if (obj.category_name) entry.category = obj.category_name
        if (obj.category) entry.category = entry.category || obj.category
        if (obj.fan_count != null) entry.fan_count = Number(obj.fan_count)
        if (obj.followers_count != null) entry.fan_count = entry.fan_count || Number(obj.followers_count)
        if (obj.like_count != null) entry.fan_count = entry.fan_count || Number(obj.like_count)
        collected.set(String(id), entry)
      }
    })
  } catch {
    // JSON parse fail → fallback regex
    extractPagesRegex(text, collected)
  }
}

function extractGroupsFromResponse(text, collected) {
  try {
    const json = JSON.parse(text)
    walkJson(json, (obj) => {
      if (obj && typeof obj === 'object') {
        const id = obj.id || obj.groupID || obj.group_id
        if (!id || !/^\d{5,}$/.test(String(id))) return
        const isGroup = obj.__typename === 'Group'
          || obj.group_id || obj.groupID
          || obj.member_count !== undefined
          || obj.group_privacy
          || obj.group_member_count !== undefined
        if (!isGroup) return

        // Filter: chỉ lấy groups mà user đã tham gia
        // Facebook trả về các trường này cho joined groups
        const isJoined = obj.viewer_has_joined            // true
          || obj.viewer_membership_state                    // "MEMBER", "ADMIN"
          || obj.viewer_join_state === 'MEMBER'
          || obj.viewer_join_state === 'ADMIN'
          || obj.is_viewer_member                           // true
          || obj.viewer_actor_is_member                     // true
          || obj.joined_at                                  // timestamp = đã join
          || obj.is_admin                                   // admin = đã join
          || obj.viewer_is_admin                            // admin = đã join
        // Nếu không có evidence → bỏ qua (có thể là suggested group)
        // Nhưng VẪN chấp nhận nếu đã có trong collected (từ DOM / other source)
        if (!isJoined && !collected.has(String(id))) return

        const entry = collected.get(String(id)) || { fb_group_id: String(id) }
        if (obj.name) entry.name = obj.name
        if (obj.member_count != null) entry.member_count = Number(obj.member_count)
        if (obj.group_member_count != null) entry.member_count = entry.member_count || Number(obj.group_member_count)
        if (obj.group_privacy) {
          const p = String(obj.group_privacy).toLowerCase()
          entry.group_type = (p === 'open' || p === 'public') ? 'public' : 'closed'
        }
        if (obj.privacy) {
          const p = String(obj.privacy).toLowerCase()
          if (!entry.group_type) entry.group_type = (p === 'open' || p === 'public') ? 'public' : 'closed'
        }
        // Track admin status
        if (obj.is_admin || obj.viewer_is_admin || obj.viewer_membership_state === 'ADMIN') {
          entry.is_admin = true
        }
        collected.set(String(id), entry)
      }
    })
  } catch {
    extractGroupsRegex(text, collected)
  }
}

/** Walk JSON tree, call fn on every object */
function walkJson(obj, fn, depth = 0) {
  if (depth > 15) return // prevent infinite recursion
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

/** Layer 2: Regex fallback khi JSON.parse fail */
function extractPagesRegex(text, collected) {
  for (const m of text.matchAll(/\{[^{}]{0,3000}?"(?:pageID|id)"\s*:\s*"(\d{8,})"[^{}]{0,3000}?\}/g)) {
    const block = m[0], id = m[1]
    // Phải có dấu hiệu Page (typename hoặc pageID field)
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

/** Regex fallback: extract group data from raw text */
function extractGroupsRegex(text, collected) {
  for (const m of text.matchAll(/"groupID"\s*:\s*"(\d{5,})"/g)) {
    if (!collected.has(m[1])) collected.set(m[1], { fb_group_id: m[1] })
  }
  for (const m of text.matchAll(/\{[^{}]{0,3000}?"id"\s*:\s*"(\d{5,})"[^{}]{0,3000}?\}/g)) {
    const block = m[0]
    const id = m[1]
    if (!block.includes('"Group"') && !block.includes('"groupID"') && !block.includes('"member_count"') && !block.includes('"group_privacy"')) continue
    const entry = collected.get(id) || { fb_group_id: id }
    const nameMatch = block.match(/"name"\s*:\s*"([^"]{2,150})"/)
    if (nameMatch) entry.name = nameMatch[1]
    const memberMatch = block.match(/"(?:member_count|group_member_count)"\s*:\s*(\d+)/)
    if (memberMatch) entry.member_count = parseInt(memberMatch[1])
    const privMatch = block.match(/"group_privacy"\s*:\s*"([^"]+)"/)
    if (privMatch) {
      const p = privMatch[1].toLowerCase()
      entry.group_type = (p === 'open' || p === 'public') ? 'public' : 'closed'
    }
    collected.set(id, entry)
  }
}

// ─────────────────────────────────────────────────────────────────
// DOM EXTRACTION: Embedded JSON + Visual links (fallback layers)
// ─────────────────────────────────────────────────────────────────

/** Layer 3: Extract pages từ DOM — 4 strategies progressively */
async function extractPagesFromDOM(page) {
  return page.evaluate(() => {
    const results = []
    const seen = new Set()

    // Blacklist system page names (copy vào evaluate context)
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

    // --- 3a: Scan <script> tags for page data ---
    // Facebook embeds SSR data in <script> tags, often with pageID
    for (const script of document.querySelectorAll('script')) {
      const text = script.textContent || ''
      if (text.length < 100 || text.length > 1000000) continue
      // Chỉ scan script tags chứa page-related keywords
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

    // --- 3b: Embedded JSON blocks trong [role="main"] innerHTML ---
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

    // --- 3c: Visual page links — numeric ID in href ---
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

    // --- 3d: Page card detection — tìm cards có nút "Tạo bài viết" ---
    // Facebook dashboard hiển thị page cards, mỗi card có nút "Tạo bài viết" + "Quảng cáo"
    // Walk up từ nút này để tìm page name + ID từ các links trong card
    const createBtnTexts = ['tạo bài viết', 'create post', 'create a post']
    const allElements = mainContent.querySelectorAll('span, a, div[role="button"]')
    for (const el of allElements) {
      const text = el.textContent?.trim()?.toLowerCase()
      if (!text || !createBtnTexts.some(t => text === t)) continue

      // Walk up DOM to find card container (max 10 levels)
      let container = el.parentElement
      for (let i = 0; i < 10 && container && container !== mainContent; i++) {
        const links = container.querySelectorAll('a[href]')
        if (links.length >= 2) break // Tìm được card chứa nhiều links
        container = container.parentElement
      }
      if (!container || container === mainContent) continue

      // Scan ALL links + images trong card này để tìm page ID
      const cardLinks = container.querySelectorAll('a[href]')
      let pageId = null, pageName = null
      for (const link of cardLinks) {
        const href = link.getAttribute('href') || ''
        const linkText = link.textContent?.trim()?.split('\n')[0]?.trim()

        // Skip button text
        if (linkText && createBtnTexts.includes(linkText.toLowerCase())) continue
        if (linkText && /^quảng cáo$|^advertise$/i.test(linkText)) continue

        // Try to extract numeric ID from any link in the card
        const idMatch = href.match(/\/(\d{8,})\/?/) || href.match(/page_id=(\d{8,})/) || href.match(/[?&]id=(\d{8,})/)
        if (idMatch) pageId = idMatch[1]

        // First meaningful link text = page name
        if (!pageName && linkText && linkText.length >= 2 && linkText.length <= 200) {
          pageName = linkText
        }
      }

      // Nếu chưa có ID, kiểm tra avatar image (FB embed page ID trong image URL)
      if (!pageId) {
        const imgs = container.querySelectorAll('img[src]')
        for (const img of imgs) {
          const src = img.getAttribute('src') || ''
          // Facebook CDN URLs đôi khi chứa page ID: /p123456789/
          const imgId = src.match(/\/p(\d{8,})\//) || src.match(/\/(\d{8,})_/)
          if (imgId) { pageId = imgId[1]; break }
        }
      }

      // Nếu vẫn chưa có ID, dùng vanity slug từ href
      if (!pageId) {
        for (const link of cardLinks) {
          const href = link.getAttribute('href') || ''
          const linkText = link.textContent?.trim()?.split('\n')[0]?.trim()
          if (linkText && createBtnTexts.includes(linkText.toLowerCase())) continue
          if (linkText && /^quảng cáo$|^advertise$/i.test(linkText)) continue
          // Vanity URL: /page-name/ hoặc /page.name/
          const slugMatch = href.match(/^https?:\/\/(?:www\.)?facebook\.com\/([a-zA-Z0-9._-]{2,50})\/?$/)
            || href.match(/^\/([a-zA-Z0-9._-]{2,50})\/?$/)
          if (slugMatch && pageName) {
            // Dùng slug làm temp ID — sẽ resolve sau
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

async function extractGroupsFromDOM(page) {
  return page.evaluate(() => {
    const results = []
    const seen = new Set()
    const src = document.documentElement.innerHTML

    // System paths trong /groups/ — không phải group vanity slug
    const groupSystemPaths = new Set([
      'joins', 'discover', 'feed', 'create', 'search', 'notifications',
      'settings', 'your_groups', 'suggested', 'browse', 'new',
    ])

    function isValidGroupName(name) {
      return name && name.length > 1 && name.length < 150 && !name.includes('\n')
        && !/^xem nhóm$/i.test(name) && !/^xem thêm$/i.test(name)
        && !/^see more$/i.test(name) && !/^view group$/i.test(name)
    }

    // DOM links
    // Lưu ý: mỗi group card có nhiều <a> cùng href (avatar, tên, "Xem nhóm")
    // Chỉ add vào seen khi tìm được name hợp lệ — tránh avatar link (textContent trống) block name link
    for (const link of document.querySelectorAll('a[href*="/groups/"]')) {
      const href = link.getAttribute('href')

      // Ưu tiên numeric ID
      const idMatch = href?.match(/\/groups\/(\d+)/)
      if (idMatch && !seen.has(idMatch[1])) {
        const name = link.textContent?.trim()
        if (isValidGroupName(name)) {
          seen.add(idMatch[1])
          results.push({ fb_group_id: idMatch[1], name })
        }
        continue
      }

      // Vanity slug groups: /groups/groupname hoặc /groups/group.name
      if (!idMatch) {
        const slugMatch = href?.match(/\/groups\/([a-zA-Z][a-zA-Z0-9._-]{1,49})\/?(?:\?|$)/)
        if (slugMatch && !groupSystemPaths.has(slugMatch[1].toLowerCase()) && !seen.has(slugMatch[1])) {
          const name = link.textContent?.trim()
          if (isValidGroupName(name)) {
            seen.add(slugMatch[1])
            results.push({ fb_group_id: slugMatch[1], name })
          }
        }
      }
    }

    // Embedded JSON
    for (const m of src.matchAll(/\{[^{}]{0,2000}?"(?:groupID|id)"\s*:\s*"(\d{5,})"[^{}]{0,2000}?\}/g)) {
      const id = m[1], block = m[0]
      if (!block.includes('"Group"') && !block.includes('"groupID"') && !block.includes('"member_count"')) continue
      if (seen.has(id)) continue
      seen.add(id)
      const nameMatch = block.match(/"name"\s*:\s*"([^"]{2,150})"/)
      const memberMatch = block.match(/"(?:member_count|group_member_count)"\s*:\s*(\d+)/)
      const privMatch = block.match(/"group_privacy"\s*:\s*"([^"]+)"/)
      let group_type = null
      if (privMatch) {
        const p = privMatch[1].toLowerCase()
        group_type = (p === 'open' || p === 'public') ? 'public' : 'closed'
      }
      results.push({
        fb_group_id: id,
        name: nameMatch ? nameMatch[1] : null,
        member_count: memberMatch ? parseInt(memberMatch[1]) : null,
        group_type,
      })
    }

    return results
  })
}

// ─────────────────────────────────────────────────────────────────
// SMART SCROLL: Scroll đến khi hết data, không giới hạn số lần
// Chỉ dừng khi: timeout HOẶC hết data thật (5 lần không có gì mới)
//
// CRITICAL: onExtract chạy TRƯỚC change detection
// Nếu chạy SAU → noChangeCount tăng → break trước khi extract kịp chạy
// ─────────────────────────────────────────────────────────────────

async function smartScroll(page, collected, { label = '', isTimedOut, onSave, onExtract }) {
  let noChangeCount = 0
  let scrollCount = 0
  let lastSavedSize = collected.size
  let lastCollectedSize = collected.size

  while (!isTimedOut()) {
    // Scroll 1 bước
    await humanScroll(page)
    scrollCount++

    // Random mouse move (20% chance) — giả lập người thật
    if (Math.random() < 0.2) await humanMouseMove(page)

    // Đợi GraphQL response tới (Facebook lazy load 2-3s)
    await delay(2000, 3500)

    // ═══ DOM extraction TRƯỚC change detection (mỗi 2 scrolls) ═══
    // Đảm bảo page cards mới được bắt trước khi check "có data mới không"
    if (onExtract && scrollCount % 2 === 0) {
      await onExtract()
    }

    // ═══ Click "Xem thêm" / "See more" / "Load more" nếu có ═══
    // Facebook có thể dùng nút load-more thay vì infinite scroll
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
            return text
          }
        }
      }
      // Fallback: span bên trong button
      for (const span of main.querySelectorAll('div[role="button"] span')) {
        if (span.closest('div[role="button"]')?.dataset?.__sfClicked) continue
        const text = span.textContent?.trim()?.toLowerCase()
        if (text && moreTexts.includes(text)) {
          const rect = span.getBoundingClientRect()
          if (rect.height > 0 && rect.width > 0) {
            const parentBtn = span.closest('div[role="button"]')
            if (parentBtn) parentBtn.dataset.__sfClicked = '1'
            span.click()
            return text
          }
        }
      }
      return null
    })
    if (clickedMore) {
      console.log(`[FETCH-ALL] ${label} clicked "${clickedMore}" button`)
      await delay(3000, 5000)
      if (onExtract) await onExtract()
    }

    // ═══ Change detection ═══
    const heightChanged = await page.evaluate(() => {
      const h = document.body.scrollHeight
      const prev = window.__lastHeight || 0
      window.__lastHeight = h
      return h !== prev
    })

    if (collected.size > lastCollectedSize || heightChanged) {
      // Có data mới → reset counter
      noChangeCount = 0
      lastCollectedSize = collected.size
    } else {
      noChangeCount++

      // Khi không có data mới, đợi lâu hơn (FB load chậm)
      await delay(1500, 2500)

      // Sau 3 lần: thử trick scroll ngược lên rồi xuống — trigger lazy load
      if (noChangeCount === 3) {
        console.log(`[FETCH-ALL] ${label} no new data x3, trying scroll trick...`)
        await page.evaluate(() => window.scrollBy(0, -800))
        await delay(1500, 2500)
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
        await delay(3000, 4000)

        // Extract + check lại sau trick
        if (onExtract) await onExtract()
        if (collected.size > lastCollectedSize) {
          noChangeCount = 0
          lastCollectedSize = collected.size
        }
      }

      // Hết data thật
      if (noChangeCount >= NO_CHANGE_LIMIT) {
        console.log(`[FETCH-ALL] ${label} scroll complete: no new data after ${NO_CHANGE_LIMIT} attempts`)
        break
      }
    }

    // Log progress
    if (scrollCount % 10 === 0) {
      console.log(`[FETCH-ALL] ${label} scroll: ${scrollCount}, found: ${collected.size}`)
    }

    // Incremental save — không đợi hết scroll mới save
    if (onSave && scrollCount % SAVE_INTERVAL === 0 && collected.size > lastSavedSize) {
      console.log(`[FETCH-ALL] ${label} incremental save: ${collected.size} items`)
      await onSave()
      lastSavedSize = collected.size
    }

    // Giả lập dừng đọc (10% chance) — tránh bị detect bot
    if (Math.random() < 0.1) {
      await delay(2000, 4000)
      await humanMouseMove(page)
    }
  }

  if (isTimedOut()) {
    console.log(`[FETCH-ALL] ${label} scroll stopped: timeout after ${scrollCount} scrolls`)
  }

  console.log(`[FETCH-ALL] ${label} total: ${scrollCount} scrolls, ${collected.size} items`)
}

// ─────────────────────────────────────────────────────────────────
// MAIN HANDLER
// ─────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────
// SAVE HELPERS
// ─────────────────────────────────────────────────────────────────

async function savePages(pages, account_id, supabase) {
  let saved = 0
  for (const p of pages) {
    const { error } = await supabase.from('fanpages').upsert({
      account_id,
      fb_page_id: p.fb_page_id,
      name: p.name || `Page ${p.fb_page_id}`,
      url: `https://www.facebook.com/${p.fb_page_id}`,
      ...(p.category && { category: p.category }),
      ...(p.fan_count && { fan_count: p.fan_count }),
    }, { onConflict: 'account_id,fb_page_id' })
    if (!error) saved++
  }
  return saved
}

async function saveGroups(groups, account_id, supabase) {
  let saved = 0
  for (const g of groups) {
    const { error } = await supabase.from('fb_groups').upsert({
      account_id,
      fb_group_id: g.fb_group_id,
      name: g.name || `Group ${g.fb_group_id}`,
      url: `https://www.facebook.com/groups/${g.fb_group_id}`,
      ...(g.member_count && { member_count: g.member_count }),
      ...(g.group_type && { group_type: g.group_type }),
    }, { onConflict: 'account_id,fb_group_id' })
    if (!error) saved++
  }
  return saved
}

// ─────────────────────────────────────────────────────────────────
// STRATEGY 1: Direct HTTP API (nhanh nhất — 10-30 giây)
// Không cần browser, gọi thẳng Facebook bằng cookie + proxy
// ─────────────────────────────────────────────────────────────────

async function fetchViaDirectAPI(account, account_id, supabase) {
  if (!account.fb_dtsg) {
    console.log(`[FETCH-ALL] No fb_dtsg — skipping direct API, need browser`)
    return null
  }

  console.log(`[FETCH-ALL] Trying DIRECT API (no browser)...`)

  try {
    const fbApi = new FacebookAPI(account)
    const result = { pages_found: 0, pages_saved: 0, groups_found: 0, groups_saved: 0, status: 'ok', method: 'direct_api', fetchedPageIds: [], fetchedGroupIds: [] }

    // Fetch pages
    console.log(`[FETCH-ALL] [API] Fetching pages...`)
    const pagesResult = await fbApi.fetchManagedPages()
    if (pagesResult.blocked) {
      console.log(`[FETCH-ALL] [API] Pages blocked (HTTP redirect) — will verify via browser`)
      return null // fallback to browser
    }

    const pages = pagesResult.pages
      .filter(p => p.fb_page_id && p.fb_page_id.length >= 5)
      .map(p => ({ ...p, name: decodeUnicode(p.name), category: decodeUnicode(p.category) }))
    result.pages_found = pages.length
    result.pages_saved = await savePages(pages, account_id, supabase)
    result.fetchedPageIds = pages.map(p => p.fb_page_id)
    console.log(`[FETCH-ALL] [API] Pages: ${result.pages_found} found, ${result.pages_saved} saved`)

    // Fetch groups
    console.log(`[FETCH-ALL] [API] Fetching groups...`)
    const groupsResult = await fbApi.fetchJoinedGroups()
    if (groupsResult.blocked) {
      console.log(`[FETCH-ALL] [API] Groups blocked (HTTP redirect) — will verify via browser`)
      if (result.pages_found > 0) return result
      return null // fallback to browser
    }

    const groups = groupsResult.groups
      .filter(g => g.fb_group_id && g.fb_group_id.length >= 5)
      .map(g => ({ ...g, name: decodeUnicode(g.name) }))
    result.groups_found = groups.length
    result.groups_saved = await saveGroups(groups, account_id, supabase)
    result.fetchedGroupIds = groups.map(g => g.fb_group_id)
    console.log(`[FETCH-ALL] [API] Groups: ${result.groups_found} found, ${result.groups_saved} saved`)

    // Nếu tìm được ít nhất 1 thứ → coi là thành công
    if (result.pages_found > 0 || result.groups_found > 0) {
      return result
    }

    console.log(`[FETCH-ALL] [API] No data found — falling back to browser`)
    return null // null = fallback to browser
  } catch (err) {
    console.log(`[FETCH-ALL] [API] Failed: ${err.message} — falling back to browser`)
    return null
  }
}

// ─────────────────────────────────────────────────────────────────
// STRATEGY 2: Browser with Network Interception (fallback)
// Mở browser, bắt GraphQL responses + DOM scraping
// ─────────────────────────────────────────────────────────────────

async function fetchViaBrowser(account, account_id, supabase, startTime) {
  const isTimedOut = () => Date.now() - startTime > JOB_TIMEOUT_MS

  console.log(`[FETCH-ALL] Using BROWSER with network interception + scroll...`)

  let page
  try {
    const session = await getPage(account, { headless: true })
    page = session.page

    const result = { pages_found: 0, pages_saved: 0, groups_found: 0, groups_saved: 0, status: 'ok', method: 'browser', fetchedPageIds: [], fetchedGroupIds: [] }

    // ===== PHASE 1: Pages =====
    console.log(`[FETCH-ALL] [Browser] === Pages ===`)
    const collectedPages = new Map()

    const pageHandler = async (response) => {
      try {
        const url = response.url()
        if (!url.includes('/api/graphql') && !url.includes('graphql')) return
        graphqlStats.total++
        const ct = response.headers()['content-type'] || ''
        if (!ct.includes('json') && !ct.includes('text') && !ct.includes('javascript')) return
        const text = await response.text().catch(() => { graphqlStats.errors++; return '' })
        if (!text || text.length < 50) return
        // Broader matching — bắt nhiều format hơn
        if (text.includes('"Page"') || text.includes('"pageID"')
          || text.includes('"fan_count"') || text.includes('"category_name"')
          || text.includes('"page_id"') || text.includes('"page_admin"')
          || text.includes('"managed_page"') || text.includes('"ownerID"')
          || text.includes('"pages_tab"') || text.includes('"your_pages"')) {
          graphqlStats.matched++
          extractPagesFromResponse(text, collectedPages)
        }
      } catch {}
    }
    page.on('response', pageHandler)

    // Incremental save callback — save ngay khi scroll tìm được data mới
    // Chấp nhận cả numeric ID và vanity slug (skip slug: prefix entries)
    const savePagesCb = async () => {
      const pages = [...collectedPages.values()]
        .filter(p => p.fb_page_id && isValidIdentifier(p.fb_page_id))
        .map(p => ({ ...p, name: decodeUnicode(p.name), category: decodeUnicode(p.category) }))
      result.pages_saved = await savePages(pages, account_id, supabase)
      result.pages_found = pages.length
    }

    // Thử nhiều URLs — Facebook hay thay đổi nơi hiển thị pages
    // KHÔNG break sau URL đầu tiên — accumulate từ tất cả URLs
    const pageUrls = [
      'https://www.facebook.com/pages/?category=your_pages',
      'https://www.facebook.com/pages/?category=your_pages&ref=bookmarks',
      'https://www.facebook.com/bookmarks/pages',
    ]
    let graphqlStats = { total: 0, matched: 0, errors: 0 }
    for (const url of pageUrls) {
      if (isTimedOut()) break
      console.log(`[FETCH-ALL] Trying: ${url}`)
      try {
        // Dùng 'load' thay vì 'domcontentloaded' — đợi JS render xong
        await page.goto(url, { waitUntil: 'load', timeout: 30000 })

        // Đợi [role="main"] có links (= page cards đã render)
        await page.waitForFunction(() => {
          const main = document.querySelector('[role="main"]')
          if (!main) return false
          return main.querySelectorAll('a[href]').length >= 3
        }, { timeout: 15000 }).catch(() => {
          console.log(`[FETCH-ALL] Warning: [role="main"] chưa có đủ links sau 15s`)
        })
        await delay(3000, 5000)

        const status = await checkAccountStatus(page, supabase, account_id)
        if (status.blocked) {
          result.status = status.reason
          page.removeListener('response', pageHandler)
          // Keep page on FB for session reuse
          releaseSession(account_id)
          return result
        }

        // DOM extraction trước scroll — lấy ngay dữ liệu có sẵn
        const domPages = await extractPagesFromDOM(page)
        for (const p of domPages) {
          if (p.fb_page_id && !collectedPages.has(p.fb_page_id)) collectedPages.set(p.fb_page_id, p)
        }
        console.log(`[FETCH-ALL] GraphQL: ${graphqlStats.total} responses, ${graphqlStats.matched} matched, ${graphqlStats.errors} errors`)
        console.log(`[FETCH-ALL] After initial extract: ${collectedPages.size} pages (graphql+dom)`)

        // Quick bail: nếu initial load + 2 scrolls = 0 data → skip URL (tiết kiệm 30-40s)
        const beforeScroll = collectedPages.size
        if (beforeScroll === 0) {
          console.log(`[FETCH-ALL] No initial data, quick scroll test...`)
          for (let i = 0; i < QUICK_BAIL_LIMIT; i++) {
            await humanScroll(page)
            await delay(2000, 3000)
          }
          const domRetry = await extractPagesFromDOM(page)
          for (const p of domRetry) {
            if (p.fb_page_id && !collectedPages.has(p.fb_page_id)) collectedPages.set(p.fb_page_id, p)
          }
          if (collectedPages.size === 0) {
            console.log(`[FETCH-ALL] URL empty after scroll test, skipping: ${url}`)
            continue
          }
        }

        // Có data → scroll tiếp để lấy hết
        // Thêm DOM extraction trong scroll callback — bắt page cards được render qua scroll
        const scrollDomExtract = async () => {
          const domExtra = await extractPagesFromDOM(page)
          for (const p of domExtra) {
            if (p.fb_page_id && !collectedPages.has(p.fb_page_id)) collectedPages.set(p.fb_page_id, p)
          }
        }
        await smartScroll(page, collectedPages, {
          label: 'Pages', isTimedOut, onSave: savePagesCb,
          onExtract: scrollDomExtract,
        })

        // Final DOM extraction
        const finalDom = await extractPagesFromDOM(page)
        for (const p of finalDom) {
          if (p.fb_page_id && !collectedPages.has(p.fb_page_id)) collectedPages.set(p.fb_page_id, p)
        }

        console.log(`[FETCH-ALL] Total pages from ${url}: ${collectedPages.size}`)
        // KHÔNG break — tiếp tục thử URL khác để accumulate thêm pages
      } catch (err) {
        console.log(`[FETCH-ALL] Pages URL failed: ${url} - ${err.message}`)
      }
    }
    page.removeListener('response', pageHandler)

    if (collectedPages.size === 0) {
      try {
        const debugDir = path.join(__dirname, '..', '..', 'debug')
        if (!fs.existsSync(debugDir)) fs.mkdirSync(debugDir, { recursive: true })
        const ts = Date.now()
        await page.screenshot({ path: path.join(debugDir, `fetch-pages-debug-${ts}.png`), fullPage: false })

        // Diagnostic: thông tin hữu ích thay vì dump 50KB CSS
        const diagnostics = await page.evaluate(() => {
          const main = document.querySelector('[role="main"]')
          const allLinks = main ? [...main.querySelectorAll('a[href]')] : []
          const scripts = document.querySelectorAll('script')
          let pageDataScripts = 0
          for (const s of scripts) {
            const t = s.textContent || ''
            if (t.includes('pageID') || t.includes('"Page"') || t.includes('page_id')) pageDataScripts++
          }
          return {
            url: window.location.href,
            title: document.title,
            hasMain: !!main,
            mainTextLength: main?.innerText?.length || 0,
            mainLinksCount: allLinks.length,
            totalScripts: scripts.length,
            pageDataScripts,
            sampleLinks: allLinks.slice(0, 40).map(l => ({
              href: (l.getAttribute('href') || '').substring(0, 200),
              text: (l.textContent?.trim() || '').substring(0, 80),
            })),
            bodyTextSample: (document.body?.innerText || '').substring(0, 3000),
            // Lấy innerHTML của [role="main"] thay vì toàn bộ document
            mainHTML: main ? main.innerHTML.substring(0, 150000) : 'NO_MAIN',
          }
        })

        console.log(`[FETCH-ALL] DEBUG (0 pages found):`)
        console.log(`  URL: ${diagnostics.url}`)
        console.log(`  Has [role="main"]: ${diagnostics.hasMain}`)
        console.log(`  Main text length: ${diagnostics.mainTextLength}`)
        console.log(`  Links in main: ${diagnostics.mainLinksCount}`)
        console.log(`  Total scripts: ${diagnostics.totalScripts}, with page data: ${diagnostics.pageDataScripts}`)
        console.log(`  GraphQL stats: ${graphqlStats.total} total, ${graphqlStats.matched} matched, ${graphqlStats.errors} errors`)
        console.log(`  Sample links:`)
        for (const l of diagnostics.sampleLinks.slice(0, 15)) {
          console.log(`    ${l.text.substring(0, 40)} → ${l.href.substring(0, 80)}`)
        }

        // Save diagnostic files
        fs.writeFileSync(path.join(debugDir, `fetch-pages-diag-${ts}.json`), JSON.stringify(diagnostics, null, 2))
        if (diagnostics.mainHTML !== 'NO_MAIN') {
          fs.writeFileSync(path.join(debugDir, `fetch-pages-main-${ts}.html`), diagnostics.mainHTML)
        }
        console.log(`[FETCH-ALL] DEBUG: Diagnostics saved to debug/fetch-pages-diag-${ts}.json`)
      } catch (debugErr) {
        console.log(`[FETCH-ALL] DEBUG save failed: ${debugErr.message}`)
      }
    }

    // Resolve vanity slugs (slug:AmineMusicMix → numeric ID)
    const slugEntries = [...collectedPages.entries()].filter(([id]) => id.startsWith('slug:'))
    if (slugEntries.length > 0 && !isTimedOut()) {
      console.log(`[FETCH-ALL] Resolving ${slugEntries.length} vanity slugs to numeric IDs...`)
      for (const [slugId, entry] of slugEntries) {
        if (isTimedOut()) break
        try {
          const slug = slugId.replace('slug:', '')
          let numericId = null

          // ═══ GraphQL interception — bắt pageID từ responses khi navigate ═══
          // Facebook client-render → HTML không có pageID, nhưng GraphQL responses luôn có
          const slugHandler = async (response) => {
            try {
              if (numericId) return // Đã tìm được rồi
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

          // Fallback 2: HTML parsing (meta tags + inline JSON)
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

          if (numericId && !collectedPages.has(numericId)) {
            collectedPages.delete(slugId)
            entry.fb_page_id = numericId
            collectedPages.set(numericId, entry)
            console.log(`[FETCH-ALL] Resolved: ${slug} → ${numericId} (${entry.name})`)
          } else if (numericId) {
            // numeric ID đã tồn tại trong collection → xóa slug entry
            collectedPages.delete(slugId)
            console.log(`[FETCH-ALL] Slug ${slug} → ${numericId} (already exists)`)
          } else {
            // Không resolve được → giữ vanity slug làm ID hợp lệ
            collectedPages.delete(slugId)
            entry.fb_page_id = slug
            collectedPages.set(slug, entry)
            const finalUrl = page.url()
            console.log(`[FETCH-ALL] Keeping vanity slug as ID: ${slug} (${entry.name}) (URL: ${finalUrl.substring(0, 100)})`)
          }
        } catch (err) {
          // Lỗi resolution → giữ vanity slug thay vì drop
          const slug = slugId.replace('slug:', '')
          collectedPages.delete(slugId)
          entry.fb_page_id = slug
          collectedPages.set(slug, entry)
          console.log(`[FETCH-ALL] Slug resolution error, keeping vanity: ${slug} - ${err.message}`)
        }
      }
    } else if (slugEntries.length > 0) {
      // Timeout — giữ vanity slugs làm ID hợp lệ thay vì drop
      for (const [slugId, entry] of slugEntries) {
        const slug = slugId.replace('slug:', '')
        collectedPages.delete(slugId)
        entry.fb_page_id = slug
        collectedPages.set(slug, entry)
      }
      console.log(`[FETCH-ALL] Timeout — kept ${slugEntries.length} vanity slugs as IDs`)
    }

    // Final save (bắt nốt những gì DOM extraction thêm)
    await savePagesCb()
    result.fetchedPageIds = [...collectedPages.values()]
      .filter(p => p.fb_page_id && isValidIdentifier(p.fb_page_id))
      .map(p => p.fb_page_id)
    console.log(`[FETCH-ALL] Pages done: ${result.pages_found} found, ${result.pages_saved} saved (${Math.round((Date.now() - startTime) / 1000)}s)`)

    await delay(2000, 3000)

    // ===== PHASE 2: Groups =====
    if (isTimedOut()) {
      console.log(`[FETCH-ALL] Timeout, skipping groups phase`)
      result.status = 'partial_timeout'
      // Keep page on FB for session reuse
      releaseSession(account_id)
      return result
    }

    console.log(`[FETCH-ALL] [Browser] === Groups ===`)
    const collectedGroups = new Map()

    const groupHandler = async (response) => {
      try {
        const url = response.url()
        if (!url.includes('/api/graphql') && !url.includes('graphql')) return
        const ct = response.headers()['content-type'] || ''
        if (!ct.includes('json') && !ct.includes('text')) return
        const text = await response.text().catch(() => '')
        if (!text || text.length < 50) return
        if (text.includes('"Group"') || text.includes('"groupID"') || text.includes('"member_count"') || text.includes('"group_privacy"') || text.includes('"group_id"')) {
          extractGroupsFromResponse(text, collectedGroups)
        }
      } catch {}
    }
    page.on('response', groupHandler)

    const saveGroupsCb = async () => {
      const groups = [...collectedGroups.values()]
        .filter(g => g.fb_group_id && isValidIdentifier(g.fb_group_id))
        .map(g => ({ ...g, name: decodeUnicode(g.name) }))
      result.groups_saved = await saveGroups(groups, account_id, supabase)
      result.groups_found = groups.length
    }

    // Chỉ vào "groups/joins" — tránh suggested groups từ /groups/ feed
    for (const url of ['https://www.facebook.com/groups/joins']) {
      if (isTimedOut()) break
      console.log(`[FETCH-ALL] Trying: ${url}`)
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 })
        await delay(3000, 5000)

        const status = await checkAccountStatus(page, supabase, account_id)
        if (status.blocked) {
          result.status = status.reason
          page.removeListener('response', groupHandler)
          // Keep page on FB for session reuse
          releaseSession(account_id)
          return result
        }

        // DOM extraction trước scroll — lấy ngay dữ liệu có sẵn
        const domGroups = await extractGroupsFromDOM(page)
        for (const g of domGroups) {
          if (!collectedGroups.has(g.fb_group_id)) collectedGroups.set(g.fb_group_id, g)
        }
        if (domGroups.length > 0) {
          console.log(`[FETCH-ALL] Groups initial DOM: ${domGroups.length} found`)
        }

        // Quick bail: nếu initial load + 2 scrolls = 0 data → skip URL
        const beforeGroupScroll = collectedGroups.size
        if (beforeGroupScroll === 0) {
          console.log(`[FETCH-ALL] Groups no initial data, quick scroll test...`)
          for (let i = 0; i < QUICK_BAIL_LIMIT; i++) {
            await humanScroll(page)
            await delay(2000, 3000)
          }
          const domRetry = await extractGroupsFromDOM(page)
          for (const g of domRetry) {
            if (!collectedGroups.has(g.fb_group_id)) collectedGroups.set(g.fb_group_id, g)
          }
          if (collectedGroups.size === 0) {
            console.log(`[FETCH-ALL] Groups URL empty, skipping: ${url}`)
            continue
          }
        }

        // Scroll cho đến khi hết data — kèm DOM extraction mỗi 5 scrolls
        const scrollGroupExtract = async () => {
          const domExtra = await extractGroupsFromDOM(page)
          for (const g of domExtra) {
            if (!collectedGroups.has(g.fb_group_id)) collectedGroups.set(g.fb_group_id, g)
          }
        }
        await smartScroll(page, collectedGroups, { label: 'Groups', isTimedOut, onSave: saveGroupsCb, onExtract: scrollGroupExtract })

        // DOM extraction bổ sung sau scroll
        const finalDomGroups = await extractGroupsFromDOM(page)
        for (const g of finalDomGroups) {
          if (!collectedGroups.has(g.fb_group_id)) collectedGroups.set(g.fb_group_id, g)
        }

        console.log(`[FETCH-ALL] Total groups: ${collectedGroups.size}`)
        if (collectedGroups.size > 0) break
      } catch (err) {
        console.log(`[FETCH-ALL] Groups URL failed: ${url} - ${err.message}`)
      }
    }
    page.removeListener('response', groupHandler)

    if (collectedGroups.size === 0) {
      try {
        const debugDir = path.join(__dirname, '..', '..', 'debug')
        if (!fs.existsSync(debugDir)) fs.mkdirSync(debugDir, { recursive: true })
        await page.screenshot({ path: path.join(debugDir, `fetch-groups-debug-${Date.now()}.png`), fullPage: false })
      } catch {}
    }

    // Final save
    await saveGroupsCb()
    result.fetchedGroupIds = [...collectedGroups.values()]
      .filter(g => g.fb_group_id && isValidIdentifier(g.fb_group_id))
      .map(g => g.fb_group_id)
    console.log(`[FETCH-ALL] Groups done: ${result.groups_found} found, ${result.groups_saved} saved (${Math.round((Date.now() - startTime) / 1000)}s)`)

    // Cleanup
    await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {})
    // Keep page on FB for session reuse
    releaseSession(account_id)

    return result
  } catch (err) {
    console.error(`[FETCH-ALL] [Browser] Error:`, err.message)
    // Keep page on FB for session reuse
    releaseSession(account_id)
    throw err
  }
}

// ─────────────────────────────────────────────────────────────────
// MAIN HANDLER
// Direct API lấy batch đầu → Browser scroll lấy phần còn lại
// ─────────────────────────────────────────────────────────────────

async function fetchAllHandler(payload, supabase) {
  const { account_id } = payload
  const startTime = Date.now()

  const { data: account } = await supabase
    .from('accounts')
    .select('*, proxies(*)')
    .eq('id', account_id)
    .single()

  if (!account) throw new Error('Account not found')

  console.log(`[FETCH-ALL] Start for ${account.username || account_id}`)

  // STEP 1: Direct API — lấy nhanh batch đầu (nếu có fb_dtsg)
  // Lưu ý: API bị block không có nghĩa account bị block — chỉ browser xác định được
  const apiResult = await fetchViaDirectAPI(account, account_id, supabase)
  if (apiResult) {
    console.log(`[FETCH-ALL] API got initial batch: ${apiResult.pages_found} pages, ${apiResult.groups_found} groups`)
  }

  // STEP 2: Browser scroll — LUÔN chạy để lấy thêm data mà API bỏ sót
  console.log(`[FETCH-ALL] Starting browser scroll to get complete data...`)
  const browserResult = await fetchViaBrowser(account, account_id, supabase, startTime)

  // Merge results — lấy số lớn hơn (browser upsert nên không trùng)
  const finalResult = {
    pages_found: Math.max(browserResult.pages_found, apiResult?.pages_found || 0),
    pages_saved: Math.max(browserResult.pages_saved, apiResult?.pages_saved || 0),
    groups_found: Math.max(browserResult.groups_found, apiResult?.groups_found || 0),
    groups_saved: Math.max(browserResult.groups_saved, apiResult?.groups_saved || 0),
    status: browserResult.status,
    method: apiResult ? 'api+browser' : 'browser',
  }

  // ── SYNC: không có trong lần quét mới → xóa. Có → upsert đã chạy sẵn lúc scroll ──
  // Chỉ sync khi status OK. Bị blocked → giữ data cũ (không tin được kết quả)
  const canSync = finalResult.status === 'ok'
  const allFetchedPageIds = [...new Set([...(apiResult?.fetchedPageIds || []), ...(browserResult.fetchedPageIds || [])])]
  const allFetchedGroupIds = [...new Set([...(apiResult?.fetchedGroupIds || []), ...(browserResult.fetchedGroupIds || [])])]

  // Chỉ cleanup khi fetch thực sự trả về kết quả — nếu fetch 0 results thì giữ data cũ
  const hasPages = allFetchedPageIds.length > 0
  const hasGroups = allFetchedGroupIds.length > 0

  if (canSync && (hasPages || hasGroups)) {
    if (hasPages) {
      const { data: oldPages } = await supabase.from('fanpages').select('id, fb_page_id').eq('account_id', account_id)
      const stalePages = (oldPages || []).filter(p => !allFetchedPageIds.includes(p.fb_page_id))
      if (stalePages.length > 0) {
        await supabase.from('fanpages').delete().in('id', stalePages.map(p => p.id))
        console.log(`[FETCH-ALL] Xóa ${stalePages.length} pages cũ không còn trong lần quét`)
      }
    }

    if (hasGroups) {
      const { data: oldGroups } = await supabase.from('fb_groups').select('id, fb_group_id').eq('account_id', account_id)
      const staleGroups = (oldGroups || []).filter(g => !allFetchedGroupIds.includes(g.fb_group_id))
      if (staleGroups.length > 0) {
        await supabase.from('fb_groups').delete().in('id', staleGroups.map(g => g.id))
        console.log(`[FETCH-ALL] Xóa ${staleGroups.length} groups cũ không còn trong lần quét`)
      }
    }

    console.log(`[FETCH-ALL] Sync done: ${allFetchedPageIds.length} pages, ${allFetchedGroupIds.length} groups`)
  } else {
    console.log(`[FETCH-ALL] Skip sync (status=${finalResult.status})`)
  }

  const totalTime = Math.round((Date.now() - startTime) / 1000)
  console.log(`[FETCH-ALL] COMPLETE in ${totalTime}s:`, finalResult)
  return finalResult
}

module.exports = fetchAllHandler
