const { chromium } = require('playwright')
const path = require('path')
const os = require('os')
const fs = require('fs')

const PROFILES_DIR = path.join(os.homedir(), '.socialflow', 'profiles')

async function launchBrowser(account, options = {}) {
  const profileDir = path.join(PROFILES_DIR, account.id)
  fs.mkdirSync(profileDir, { recursive: true })

  const storageFile = path.join(profileDir, 'storage.json')
  const proxyConfig = account.proxy || null

  // headless priority: options.headless > env HEADLESS > default false
  // Fetch/scan jobs nên chạy headless để không chiếm màn hình
  const headless = options.headless !== undefined ? options.headless : process.env.HEADLESS === 'true'

  const launchOptions = {
    headless,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-infobars',
      ...(headless ? ['--disable-gpu'] : []),
    ],
    ...(proxyConfig && {
      proxy: {
        server: `${proxyConfig.type || 'http'}://${proxyConfig.host}:${proxyConfig.port}`,
        username: proxyConfig.username,
        password: proxyConfig.password
      }
    })
  }

  let browserType = chromium
  if (account.browser_type === 'camoufox') {
    const { firefox } = require('playwright')
    const camoPath = getCamoufoxPath()
    if (fs.existsSync(camoPath)) {
      browserType = firefox
      launchOptions.executablePath = camoPath
    } else {
      console.warn('[WARN] Camoufox not found, falling back to Chromium')
    }
  }

  const browser = await browserType.launch(launchOptions)

  const contextOptions = {
    userAgent: account.user_agent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: account.viewport || { width: 1366, height: 768 },
    locale: 'vi-VN',
    timezoneId: account.timezone || 'Asia/Ho_Chi_Minh',
    ...(fs.existsSync(storageFile) && { storageState: storageFile })
  }

  const context = await browser.newContext(contextOptions)

  // Anti-detection
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3] })
    window.chrome = { runtime: {} }
  })

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
