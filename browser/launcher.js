const { chromium } = require('playwright')
const path = require('path')
const os = require('os')
const fs = require('fs')

const PROFILES_DIR = path.join(os.homedir(), '.socialflow', 'profiles')

async function launchBrowser(account, options = {}) {
  const accountId = account.id || 'default'
  const profileDir = path.join(PROFILES_DIR, accountId)
  const userDataDir = path.join(profileDir, 'browser-data')
  fs.mkdirSync(userDataDir, { recursive: true })

  const storageFile = path.join(profileDir, 'storage.json')

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
      ...(headless ? ['--disable-gpu'] : []),
    ],
    ignoreDefaultArgs: ['--enable-automation'],
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

  // Anti-detection
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3] })
    window.chrome = { runtime: {} }
  })

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

module.exports = { launchBrowser, saveAndClose, delay, humanType, getCamoufoxPath }
