/**
 * Facebook Direct HTTP API
 * Gọi thẳng Facebook bằng cookie, parse HTML để lấy pages/groups
 * Dùng cả desktop + mobile Facebook để tăng khả năng match
 */

const axios = require('axios')
const { HttpsProxyAgent } = require('https-proxy-agent')
const path = require('path')
const fs = require('fs')

const DEBUG_DIR = path.join(__dirname, '..', 'debug')

class FacebookAPI {
  constructor(account) {
    this.cookie = account.cookie_string
    this.dtsg = account.fb_dtsg
    this.userId = account.fb_user_id
    this.userAgent = account.user_agent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

    this.proxyAgent = null
    const proxy = account.proxies || account.proxy
    if (proxy && proxy.host) {
      const auth = proxy.username ? `${proxy.username}:${proxy.password}@` : ''
      const protocol = proxy.type === 'socks5' ? 'socks5' : 'http'
      this.proxyAgent = new HttpsProxyAgent(`${protocol}://${auth}${proxy.host}:${proxy.port}`)
    }
  }

  async fetchHTML(url, mobile = false) {
    const ua = mobile
      ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
      : this.userAgent

    const { data } = await axios.get(url, {
      headers: {
        'Cookie': this.cookie,
        'User-Agent': ua,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Site': 'none',
      },
      ...(this.proxyAgent && { httpsAgent: this.proxyAgent }),
      timeout: 25000,
      maxRedirects: 5,
    })
    return data
  }

  _saveDebug(filename, content) {
    try {
      if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true })
      fs.writeFileSync(path.join(DEBUG_DIR, filename), content)
    } catch {}
  }

  _isBlocked(html) {
    return html.includes('/checkpoint/') || html.includes('/login.php') ||
      html.includes('login_form') || html.includes('/login/?')
  }

  // ═══════════════════════════════════════
  // FETCH PAGES
  // ═══════════════════════════════════════

  async fetchManagedPages() {
    const allPages = new Map()

    // Strategy 1: Desktop Facebook
    const desktopUrls = [
      'https://www.facebook.com/pages/?category=your_pages',
      'https://www.facebook.com/bookmarks/pages',
    ]
    for (const url of desktopUrls) {
      try {
        console.log(`[FB-API] Pages desktop: ${url}`)
        const html = await this.fetchHTML(url)
        if (this._isBlocked(html)) return { blocked: true, pages: [] }
        this._extractPagesDesktop(html, allPages)
        if (allPages.size > 0) {
          console.log(`[FB-API] Desktop found ${allPages.size} pages`)
          break
        }
      } catch (err) {
        console.log(`[FB-API] Desktop failed: ${err.message}`)
      }
    }

    // Strategy 2: Mobile Facebook — simpler HTML
    if (allPages.size === 0) {
      try {
        console.log(`[FB-API] Pages mobile: https://m.facebook.com/pages/`)
        const html = await this.fetchHTML('https://m.facebook.com/pages/', true)
        if (this._isBlocked(html)) return { blocked: true, pages: [] }
        this._extractPagesMobile(html, allPages)
        console.log(`[FB-API] Mobile found ${allPages.size} pages`)
        if (allPages.size === 0) this._saveDebug('pages-mobile-debug.html', html.substring(0, 50000))
      } catch (err) {
        console.log(`[FB-API] Mobile failed: ${err.message}`)
      }
    }

    // Strategy 3: Profile page — look for managed pages
    if (allPages.size === 0 && this.userId) {
      try {
        console.log(`[FB-API] Trying profile pages...`)
        const html = await this.fetchHTML(`https://www.facebook.com/${this.userId}/pages`)
        if (!this._isBlocked(html)) {
          this._extractPagesDesktop(html, allPages)
        }
      } catch {}
    }

    // Save debug nếu không tìm được gì
    if (allPages.size === 0) {
      console.log(`[FB-API] No pages found, saving debug HTML...`)
      try {
        const html = await this.fetchHTML('https://www.facebook.com/pages/?category=your_pages')
        this._saveDebug('pages-desktop-debug.html', html.substring(0, 100000))
      } catch {}
    }

    return { blocked: false, pages: [...allPages.values()] }
  }

  // ═══════════════════════════════════════
  // FETCH GROUPS
  // ═══════════════════════════════════════

  async fetchJoinedGroups() {
    const allGroups = new Map()

    // Strategy 1: Desktop
    const desktopUrls = [
      'https://www.facebook.com/groups/joins',
      'https://www.facebook.com/groups/',
    ]
    for (const url of desktopUrls) {
      try {
        console.log(`[FB-API] Groups desktop: ${url}`)
        const html = await this.fetchHTML(url)
        if (this._isBlocked(html)) return { blocked: true, groups: [] }
        this._extractGroupsDesktop(html, allGroups)
        if (allGroups.size > 0) {
          console.log(`[FB-API] Desktop found ${allGroups.size} groups`)
          break
        }
      } catch (err) {
        console.log(`[FB-API] Desktop failed: ${err.message}`)
      }
    }

    // Strategy 2: Mobile
    if (allGroups.size === 0) {
      try {
        console.log(`[FB-API] Groups mobile: https://m.facebook.com/groups/`)
        const html = await this.fetchHTML('https://m.facebook.com/groups/', true)
        if (this._isBlocked(html)) return { blocked: true, groups: [] }
        this._extractGroupsMobile(html, allGroups)
        console.log(`[FB-API] Mobile found ${allGroups.size} groups`)
        if (allGroups.size === 0) this._saveDebug('groups-mobile-debug.html', html.substring(0, 50000))
      } catch (err) {
        console.log(`[FB-API] Mobile failed: ${err.message}`)
      }
    }

    if (allGroups.size === 0) {
      console.log(`[FB-API] No groups found, saving debug HTML...`)
      try {
        const html = await this.fetchHTML('https://www.facebook.com/groups/joins')
        this._saveDebug('groups-desktop-debug.html', html.substring(0, 100000))
      } catch {}
    }

    return { blocked: false, groups: [...allGroups.values()] }
  }

  // ═══════════════════════════════════════
  // DESKTOP EXTRACTION — Parse embedded Relay JSON
  // ═══════════════════════════════════════

  _extractPagesDesktop(html, collected) {
    // Chỉ lấy pages có dấu hiệu managed (admin, role, is_owned, can_viewer)
    // Tìm blocks chứa pageID + managed evidence
    for (const m of html.matchAll(/\{[^{}]{0,5000}?"pageID"\s*:\s*"(\d{5,})"[^{}]{0,5000}?\}/g)) {
      const id = m[1], block = m[0]
      const hasManaged = block.includes('admin') || block.includes('role')
        || block.includes('is_owned') || block.includes('can_viewer')
        || block.includes('has_admin') || block.includes('is_published')
      // Nếu không có managed evidence, chấp nhận nếu có fan_count/category (likely real page trên your_pages)
      if (!hasManaged && !block.includes('fan_count') && !block.includes('category_name')) continue
      if (!collected.has(id)) collected.set(id, { fb_page_id: id })
      const entry = collected.get(id)
      const name = block.match(/"name"\s*:\s*"([^"]{2,200})"/)
      if (name && !entry.name) entry.name = this._decode(name[1])
      const cat = block.match(/"category_name"\s*:\s*"([^"]+)"/)
      if (cat && !entry.category) entry.category = this._decode(cat[1])
      const fan = block.match(/"(?:fan_count|followers_count|like_count)"\s*:\s*(\d+)/)
      if (fan && !entry.fan_count) entry.fan_count = parseInt(fan[1])
    }

    // __typename Page with managed context
    for (const m of html.matchAll(/"__typename"\s*:\s*"Page"[^}]{0,500}?"id"\s*:\s*"(\d{5,})"/g)) {
      if (!collected.has(m[1])) {
        const ctx = html.substring(Math.max(0, m.index - 500), m.index + 1000)
        if (ctx.includes('admin') || ctx.includes('role') || ctx.includes('is_owned') || ctx.includes('fan_count')) {
          collected.set(m[1], { fb_page_id: m[1] })
        }
      }
    }

    // Enrich metadata cho pages đã tìm được
    for (const m of html.matchAll(/\{[^{}]{0,8000}?"(?:pageID|page_id|id)"\s*:\s*"(\d{5,})"[^{}]{0,8000}?\}/g)) {
      const id = m[1], block = m[0]
      if (!collected.has(id)) continue
      const entry = collected.get(id)
      const name = block.match(/"name"\s*:\s*"([^"]{2,200})"/)
      if (name && !entry.name) entry.name = this._decode(name[1])
      const cat = block.match(/"category_name"\s*:\s*"([^"]+)"/)
      if (cat && !entry.category) entry.category = this._decode(cat[1])
      const fan = block.match(/"(?:fan_count|followers_count|like_count)"\s*:\s*(\d+)/)
      if (fan && !entry.fan_count) entry.fan_count = parseInt(fan[1])
    }

    // href links to /pages/NAME/ID — likely managed nếu hiện trên your_pages
    for (const m of html.matchAll(/href="[^"]*?\/pages\/[^"]*?\/(\d{5,})"/g)) {
      if (!collected.has(m[1])) collected.set(m[1], { fb_page_id: m[1] })
    }
  }

  _extractGroupsDesktop(html, collected) {
    // Pattern 1: groupID
    for (const m of html.matchAll(/"groupID"\s*:\s*"(\d{5,})"/g)) {
      if (!collected.has(m[1])) collected.set(m[1], { fb_group_id: m[1] })
    }
    // Pattern 2: group_id
    for (const m of html.matchAll(/"group_id"\s*:\s*"(\d{5,})"/g)) {
      if (!collected.has(m[1])) collected.set(m[1], { fb_group_id: m[1] })
    }
    // Pattern 3: __typename Group
    for (const m of html.matchAll(/"__typename"\s*:\s*"Group"[^}]{0,500}?"id"\s*:\s*"(\d{5,})"/g)) {
      if (!collected.has(m[1])) collected.set(m[1], { fb_group_id: m[1] })
    }
    for (const m of html.matchAll(/"id"\s*:\s*"(\d{5,})"[^}]{0,500}?"__typename"\s*:\s*"Group"/g)) {
      if (!collected.has(m[1])) collected.set(m[1], { fb_group_id: m[1] })
    }

    // Extract metadata
    for (const m of html.matchAll(/\{[^{}]{0,8000}?"(?:groupID|group_id|id)"\s*:\s*"(\d{5,})"[^{}]{0,8000}?\}/g)) {
      const id = m[1], block = m[0]
      if (!collected.has(id)) continue
      const entry = collected.get(id)
      const name = block.match(/"name"\s*:\s*"([^"]{2,200})"/)
      if (name && !entry.name) entry.name = this._decode(name[1])
      const member = block.match(/"(?:member_count|group_member_count)"\s*:\s*(\d+)/)
      if (member && !entry.member_count) entry.member_count = parseInt(member[1])
      const priv = block.match(/"(?:group_privacy|privacy)"\s*:\s*"([^"]+)"/)
      if (priv && !entry.group_type) {
        const p = priv[1].toLowerCase()
        entry.group_type = (p === 'open' || p === 'public') ? 'public' : 'closed'
      }
    }

    // Pattern 4: href links to /groups/ID
    for (const m of html.matchAll(/href="[^"]*?\/groups\/(\d{5,})"/g)) {
      if (!collected.has(m[1])) collected.set(m[1], { fb_group_id: m[1] })
    }
    // Also encoded URLs
    for (const m of html.matchAll(/\\\/groups\\\/(\d{5,})/g)) {
      if (!collected.has(m[1])) collected.set(m[1], { fb_group_id: m[1] })
    }
    // Also facebook.com/groups/ID in any context
    for (const m of html.matchAll(/facebook\.com\/groups\/(\d{5,})/g)) {
      if (!collected.has(m[1])) collected.set(m[1], { fb_group_id: m[1] })
    }
  }

  // ═══════════════════════════════════════
  // MOBILE EXTRACTION — m.facebook.com has simpler HTML
  // ═══════════════════════════════════════

  _extractPagesMobile(html, collected) {
    // Mobile HTML has simpler links: <a href="/PageName-12345/">
    // And: <a href="/pages/category/12345/">
    for (const m of html.matchAll(/href="\/pages\/[^"]*?\/(\d{5,})\/"/g)) {
      collected.set(m[1], { fb_page_id: m[1] })
    }
    for (const m of html.matchAll(/href="\/(\d{10,})\/"/g)) {
      const context = html.substring(Math.max(0, m.index - 300), m.index + 300)
      if (context.includes('page') || context.includes('Page') || context.includes('fan') || context.includes('like')) {
        collected.set(m[1], { fb_page_id: m[1] })
      }
    }
    // Also try desktop patterns on mobile HTML
    this._extractPagesDesktop(html, collected)
  }

  _extractGroupsMobile(html, collected) {
    // Mobile: <a href="/groups/12345/">
    for (const m of html.matchAll(/href="\/groups\/(\d{5,})\/"/g)) {
      collected.set(m[1], { fb_group_id: m[1] })
    }
    // Name from title or aria-label
    for (const m of html.matchAll(/href="\/groups\/(\d{5,})\/"[^>]*>([^<]{2,100})</g)) {
      const entry = collected.get(m[1]) || { fb_group_id: m[1] }
      if (!entry.name) entry.name = this._decode(m[2].trim())
      collected.set(m[1], entry)
    }
    // Also try desktop patterns
    this._extractGroupsDesktop(html, collected)
  }

  _decode(str) {
    if (!str) return str
    return str
      .replace(/\\u[\dA-Fa-f]{4}/g, m => String.fromCharCode(parseInt(m.slice(2), 16)))
      .replace(/\\"/g, '"')
      .replace(/\\\//g, '/')
  }
}

module.exports = FacebookAPI
