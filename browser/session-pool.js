/**
 * Browser Session Pool
 * Giữ browser mở giữa các job để tránh checkpoint từ việc đóng/mở liên tục
 */
const { launchBrowser } = require('./launcher')
const path = require('path')
const os = require('os')

const PROFILES_DIR = path.join(os.homedir(), '.socialflow', 'profiles')
const IDLE_TIMEOUT_MS = 15 * 60 * 1000 // 15 phút (tăng lên vì fetch có thể lâu)

// Map account_id -> { browser, context, storageFile, lastUsed, closing }
const sessions = new Map()

let cleanupInterval = null

/**
 * Lấy session hiện có hoặc tạo mới
 * @param {object} account - account record từ DB
 * @param {object} opts - { headless: boolean } - override headless mode
 */
async function getSession(account, opts = {}) {
  const id = account.id || account.account_id

  const existing = sessions.get(id)
  if (existing && !existing.closing) {
    // Check browser còn sống không
    try {
      const contexts = existing.browser.contexts()
      if (contexts.length > 0) {
        existing.lastUsed = Date.now()
        console.log(`[SESSION-POOL] Reusing session for ${account.username || id}`)
        return existing
      }
    } catch {
      // Browser đã chết, xóa và tạo mới
      sessions.delete(id)
    }
  }

  // Tạo session mới
  const headlessLabel = opts.headless ? ' (headless)' : ''
  console.log(`[SESSION-POOL] Creating new session for ${account.username || id}${headlessLabel}`)
  const session = await launchBrowser({ ...account, proxy: account.proxies ? {
    type: account.proxies.type || 'http',
    host: account.proxies.host,
    port: account.proxies.port,
    username: account.proxies.username,
    password: account.proxies.password
  } : account.proxy || null }, { headless: opts.headless })

  const entry = {
    browser: session.browser,
    context: session.context,
    storageFile: session.storageFile,
    profileDir: session.profileDir,
    lastUsed: Date.now(),
    closing: false,
  }

  sessions.set(id, entry)
  startCleanup()
  return entry
}

/**
 * Tạo page mới với cookies từ account
 * @param {object} account - account record từ DB
 * @param {object} opts - { headless: boolean } - override headless mode
 */
async function getPage(account, opts = {}) {
  const session = await getSession(account, opts)
  const page = await session.context.newPage()

  // Set cookies nếu có cookie_string
  if (account.cookie_string) {
    const cookies = account.cookie_string.split(';').map(c => {
      const [name, ...rest] = c.trim().split('=')
      return name ? {
        name: name.trim(),
        value: rest.join('=').trim(),
        domain: '.facebook.com',
        path: '/',
        secure: true,
        sameSite: 'None'
      } : null
    }).filter(Boolean)
    await session.context.addCookies(cookies)
  }

  return { page, session }
}

/**
 * Đánh dấu session idle (KHÔNG đóng)
 */
function releaseSession(accountId) {
  const session = sessions.get(accountId)
  if (session) {
    session.lastUsed = Date.now()
  }
}

/**
 * Đóng session thật + save cookies
 */
async function closeSession(accountId) {
  const session = sessions.get(accountId)
  if (!session || session.closing) return

  session.closing = true
  console.log(`[SESSION-POOL] Closing session for ${accountId}`)

  try {
    await session.context.storageState({ path: session.storageFile })
  } catch {}
  try {
    await session.browser.close()
  } catch {}

  sessions.delete(accountId)
}

/**
 * Đóng tất cả sessions (gọi khi agent shutdown)
 */
async function closeAll() {
  console.log(`[SESSION-POOL] Closing all ${sessions.size} sessions...`)
  const promises = []
  for (const [id] of sessions) {
    promises.push(closeSession(id))
  }
  await Promise.allSettled(promises)
  stopCleanup()
}

/**
 * Cleanup idle sessions - KHÔNG đóng nếu còn page đang mở (đang chạy job)
 */
function cleanupIdleSessions() {
  const now = Date.now()
  for (const [id, session] of sessions) {
    if (now - session.lastUsed > IDLE_TIMEOUT_MS && !session.closing) {
      // Check xem còn page nào đang mở không (= đang chạy job)
      try {
        const pages = session.context.pages()
        if (pages.length > 0) {
          // Có page đang mở → job đang chạy, KHÔNG đóng, refresh lastUsed
          session.lastUsed = Date.now()
          console.log(`[SESSION-POOL] Session ${id} has ${pages.length} active pages, keeping alive`)
          continue
        }
      } catch {
        // Context đã chết, đóng luôn
      }
      console.log(`[SESSION-POOL] Session ${id} idle for ${Math.round(IDLE_TIMEOUT_MS / 60000)}min, closing...`)
      closeSession(id)
    }
  }
}

function startCleanup() {
  if (!cleanupInterval) {
    cleanupInterval = setInterval(cleanupIdleSessions, 30000) // check mỗi 30s
  }
}

function stopCleanup() {
  if (cleanupInterval) {
    clearInterval(cleanupInterval)
    cleanupInterval = null
  }
}

function getActiveSessions() {
  return sessions.size
}

module.exports = {
  getSession,
  getPage,
  releaseSession,
  closeSession,
  closeAll,
  getActiveSessions,
}
