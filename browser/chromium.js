const { chromium } = require('playwright')
const { getAntiDetectScript } = require('./anti-detect')

async function launchChromium(options = {}) {
  const browser = await chromium.launch({
    headless: options.headless || false,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-infobars',
      '--disable-dev-shm-usage',
      ...(options.args || [])
    ],
    ...(options.proxy && { proxy: options.proxy })
  })

  return browser
}

async function createAntiDetectContext(browser, options = {}) {
  const context = await browser.newContext({
    userAgent: options.userAgent,
    viewport: options.viewport || { width: 1366, height: 768 },
    locale: options.locale || 'vi-VN',
    timezoneId: options.timezoneId || 'Asia/Ho_Chi_Minh',
    ...(options.storageState && { storageState: options.storageState })
  })

  await context.addInitScript(getAntiDetectScript())
  return context
}

module.exports = { launchChromium, createAntiDetectContext }
