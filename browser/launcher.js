const { chromium } = require('playwright')
const path = require('path')
const os = require('os')
const fs = require('fs')

const PROFILES_DIR = path.join(os.homedir(), '.socialflow', 'profiles')

/**
 * Parse "name=value; name2=value2; ..." cookie header format into Playwright
 * cookie objects. Returns [] on bad input. Defaults to .facebook.com domain.
 */
function parseCookieString(str) {
  if (!str || typeof str !== 'string') return []
  const trimmedStr = str.trim()
  if (!trimmedStr) return []

  // Check if it's a JSON array (e.g. from cookie exporter extensions)
  if (trimmedStr.startsWith('[') && trimmedStr.endsWith(']')) {
    try {
      const parsed = JSON.parse(trimmedStr)
      if (Array.isArray(parsed)) {
        return parsed.map(c => {
          if (!c.name || !c.value) return null
          return {
            name: c.name.trim(),
            value: String(c.value).trim(),
            domain: c.domain || '.facebook.com',
            path: c.path || '/',
            secure: c.secure !== undefined ? c.secure : true,
            sameSite: c.sameSite || 'None'
          }
        }).filter(Boolean)
      }
    } catch (e) {
      // JSON parse failed, fall back to string parsing
    }
  }

  // Handle traditional "name=value; name2=value2; ..." format
  const out = []
  for (const pair of trimmedStr.split(';')) {
    const trimmed = pair.trim()
    if (!trimmed) continue
    const eq = trimmed.indexOf('=')
    if (eq < 0) continue
    const name = trimmed.slice(0, eq).trim()
    const value = trimmed.slice(eq + 1).trim()
    if (!name || !value) continue
    out.push({
      name,
      value,
      domain: '.facebook.com',
      path: '/',
      secure: true,
      sameSite: 'None'
    })
  }
  return out
}

/**
 * Clear leftover profile lock files from a crashed browser session.
 * Without this, Chromium refuses to launch with "ProcessSingleton: failed to lock"
 * causing launchPersistentContext to throw "Target ... has been closed".
 */
function clearProfileLock(userDataDir) {
  const lockFiles = [
    path.join(userDataDir, 'SingletonLock'),
    path.join(userDataDir, 'SingletonCookie'),
    path.join(userDataDir, 'SingletonSocket'),
    path.join(userDataDir, 'lockfile'),
    path.join(userDataDir, 'Default', 'LOCK'),
    path.join(userDataDir, 'Default', 'Cookies-journal'),
  ]
  let cleared = 0
  for (const lockFile of lockFiles) {
    try {
      if (fs.existsSync(lockFile)) {
        fs.unlinkSync(lockFile)
        cleared++
      }
    } catch (e) { /* file in use or doesn't exist — ignore */ }
  }
  if (cleared > 0) {
    console.log(`[BROWSER] Cleared ${cleared} stale lock file(s) in ${userDataDir}`)
  }
  return cleared
}

async function launchBrowser(account, options = {}) {
  const accountId = account.id || 'default'
  const profileDir = path.join(PROFILES_DIR, accountId)
  const userDataDir = path.join(profileDir, 'browser-data')
  fs.mkdirSync(userDataDir, { recursive: true })

  const storageFile = path.join(profileDir, 'storage.json')

  // Clear stale lock files from previous crashed session — must run BEFORE launch
  clearProfileLock(userDataDir)

  // Clear crash flags so Chromium won't show "Restore pages?" dialog
  const prefsFile = path.join(userDataDir, 'Default', 'Preferences')
  try {
    if (fs.existsSync(prefsFile)) {
      let prefs = fs.readFileSync(prefsFile, 'utf8')
      prefs = prefs.replace(/"exit_type"\s*:\s*"Crashed"/g, '"exit_type":"Normal"')
      prefs = prefs.replace(/"exited_cleanly"\s*:\s*false/g, '"exited_cleanly":true')
      fs.writeFileSync(prefsFile, prefs)
    }
  } catch {}

  const proxyConfig = account.proxy || null

  const headless = options.headless !== undefined ? options.headless : process.env.HEADLESS === 'true'

  let browserType = chromium
  if (account.browser_type === 'camoufox') {
    const { firefox } = require('playwright')
    const camoPath = getCamoufoxPath()
    if (fs.existsSync(camoPath)) {
      browserType = firefox
    } else {
      console.warn('[WARN] Camoufox not found, falling back to Chromium')
    }
  }

  // Dùng launchPersistentContext — mỗi nick có browser data riêng biệt
  // Tránh fingerprint trùng + cookies không bị mix giữa các nick
  const contextOptions = {
    headless,
    userAgent: account.user_agent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: account.viewport || { width: 1366, height: 768 },
    locale: 'vi-VN',
    timezoneId: account.timezone || 'Asia/Ho_Chi_Minh',
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-infobars',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-session-crashed-bubble',
      '--hide-crash-restore-bubble',
      '--suppress-message-center-popups',
      '--noerrdialogs',
      // Block FB's permission prompts that hover over the page and break JS evaluation
      '--disable-notifications',
      '--disable-popup-blocking',
      '--deny-permission-prompts',
      '--disable-features=TranslateUI,WebContentsForceDark',
      // Launch minimized — visible to FB but not cluttering user's screen
      '--start-minimized',
      ...(headless ? ['--disable-gpu'] : []),
    ],
    ignoreDefaultArgs: ['--enable-automation'],
    permissions: [], // empty = deny ALL permission requests by default
    ...(proxyConfig && {
      proxy: {
        server: `${proxyConfig.type || 'http'}://${proxyConfig.host}:${proxyConfig.port}`,
        username: proxyConfig.username,
        password: proxyConfig.password
      }
    }),
    ...(account.browser_type === 'camoufox' && { executablePath: getCamoufoxPath() }),
  }

  const context = await browserType.launchPersistentContext(userDataDir, contextOptions)
  const browser = context // persistent context IS the browser

  // Chặn hình ảnh, media (video/audio) và font chữ để tiết kiệm RAM/băng thông và tránh crash
  await context.route('**/*', (route) => {
    const type = route.request().resourceType();
    if (['image', 'media', 'font'].includes(type)) {
      route.abort();
    } else {
      route.continue();
    }
  });

  // ── Sync cookies from DB into browser context ──
  // Persistent context auto-loads cookies from profile dir. But when user
  // updates `accounts.cookie_string` in DB (Sửa cookie UI), profile dir still
  // has the OLD expired cookies → checkpoint loop. Solution: if DB
  // cookie_string c_user differs from profile c_user, profile is stale → use DB.
  // Profile-side rotated cookies (FB refreshes xs every ~30min) are saved back
  // to DB by releaseSession() so DB stays current.
  if (account.cookie_string) {
    try {
      const dbCookies = parseCookieString(account.cookie_string)
      const dbCUser = dbCookies.find(c => c.name === 'c_user')?.value
      const dbXs = dbCookies.find(c => c.name === 'xs')?.value
      if (dbCUser && dbXs) {
        const profileCookies = await context.cookies(['https://www.facebook.com'])
        const profileCUser = profileCookies.find(c => c.name === 'c_user')?.value
        const profileXs = profileCookies.find(c => c.name === 'xs')?.value

        const profileEmpty = !profileCUser || !profileXs
        const profileMismatch = profileCUser !== dbCUser || profileXs !== dbXs

        if (profileEmpty || profileMismatch) {
          // Clear stale profile cookies + inject DB cookies
          await context.clearCookies()
          await context.addCookies(dbCookies.map(c => ({
            ...c,
            domain: c.domain || '.facebook.com',
            path: c.path || '/',
            secure: true,
            httpOnly: c.name === 'xs' || c.name === 'fr',
            sameSite: 'None',
          })))
          const reason = profileEmpty ? 'profile empty' : 'cookie_string newer than profile'
          console.log(`[BROWSER] 🍪 Injected DB cookies for ${account.username || accountId} (${reason}, ${dbCookies.length} cookies)`)
        } else {
          console.log(`[BROWSER] Profile cookies match DB for ${account.username || accountId}, keeping rotated tokens`)
        }
      }
    } catch (err) {
      console.warn(`[BROWSER] Cookie sync failed for ${account.username || accountId}: ${err.message}`)
    }
  }

  // ── Anti-detection + Consistent fingerprint per account ──
  // Generate deterministic fingerprint seed from account ID
  // Same account always produces same canvas/webgl/audio hash across sessions
  const fpSeed = accountId.split('').reduce((a, c) => ((a << 5) - a + c.charCodeAt(0)) | 0, 0)
  const fpAbs = Math.abs(fpSeed)

  await context.addInitScript((seed) => {
    // Basic anti-detect
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] })
    window.chrome = { runtime: {}, loadTimes: () => ({}) }

    // Consistent canvas fingerprint — adds tiny deterministic noise per account
    const origToDataURL = HTMLCanvasElement.prototype.toDataURL
    HTMLCanvasElement.prototype.toDataURL = function(type) {
      const ctx = this.getContext('2d')
      if (ctx && this.width > 0 && this.height > 0) {
        try {
          // Add 1 invisible pixel with account-specific color
          const r = (seed * 13) % 256, g = (seed * 7) % 256, b = (seed * 3) % 256
          ctx.fillStyle = `rgba(${r},${g},${b},0.01)` // nearly invisible
          ctx.fillRect(0, 0, 1, 1)
        } catch {}
      }
      return origToDataURL.apply(this, arguments)
    }

    // Consistent WebGL fingerprint
    const origGetParam = WebGLRenderingContext.prototype.getParameter
    WebGLRenderingContext.prototype.getParameter = function(param) {
      // UNMASKED_VENDOR_WEBGL / UNMASKED_RENDERER_WEBGL
      if (param === 37445) return 'Google Inc. (Intel)'
      if (param === 37446) {
        const renderers = [
          'ANGLE (Intel, Intel(R) UHD Graphics 630, OpenGL 4.5)',
          'ANGLE (Intel, Intel(R) UHD Graphics 620, OpenGL 4.5)',
          'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics, OpenGL 4.5)',
          'ANGLE (Intel, Intel(R) HD Graphics 530, OpenGL 4.5)',
        ]
        return renderers[Math.abs(seed) % renderers.length]
      }
      return origGetParam.apply(this, arguments)
    }

    // Consistent AudioContext fingerprint
    const origGetFloatFreq = AnalyserNode.prototype.getFloatFrequencyData
    AnalyserNode.prototype.getFloatFrequencyData = function(arr) {
      origGetFloatFreq.call(this, arr)
      // Add deterministic tiny noise
      for (let i = 0; i < arr.length; i++) {
        arr[i] += ((seed + i) % 100) * 0.0001
      }
    }
  }, fpAbs)

  console.log(`[BROWSER] Launched persistent context for ${account.username || accountId} → ${userDataDir}`)

  return { browser, context, profileDir, storageFile }
}

async function saveAndClose(browser, context, storageFile) {
  try { await context.storageState({ path: storageFile }) } catch {}
  try { await browser.close() } catch {}
}

function getCamoufoxPath() {
  const paths = {
    linux: path.join(os.homedir(), '.socialflow', 'browsers', 'camoufox', 'firefox'),
    darwin: path.join(os.homedir(), '.socialflow', 'browsers', 'camoufox', 'Camoufox.app/Contents/MacOS/firefox'),
    win32: path.join(os.homedir(), '.socialflow', 'browsers', 'camoufox', 'camoufox.exe')
  }
  return paths[process.platform] || paths.linux
}

const delay = (min, max) => new Promise(r => setTimeout(r, Math.random() * (max - min) + min))

async function humanType(page, selector, text) {
  await page.click(selector)
  await delay(300, 700)
  for (const char of text) {
    await page.keyboard.type(char)
    await delay(40, 180)
  }
}

module.exports = { launchBrowser, saveAndClose, delay, humanType, getCamoufoxPath, clearProfileLock, parseCookieString }
