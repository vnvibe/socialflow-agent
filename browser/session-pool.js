/**
 * Browser Session Pool
 * Giữ browser mở giữa các job để tránh checkpoint từ việc đóng/mở liên tục
 */
const { launchBrowser } = require('./launcher')
const path = require('path')
const os = require('os')

const PROFILES_DIR = path.join(os.homedir(), '.socialflow', 'profiles')
const IDLE_TIMEOUT_MS = 20 * 60 * 1000 // 20 phút — giữ session sống lâu hơn giữa jobs
const MAX_SESSIONS = 1 // CHỈ 1 browser tại 1 thời điểm — tránh FB detect multi-account từ cùng IP
const MAX_JOBS_PER_SESSION = 20    // Recycle sau 20 jobs (tăng từ 12 — tránh recycle liên tục)
const MAX_SESSION_AGE_MS = 2 * 60 * 60 * 1000 // Recycle sau 2 GIỜ (tăng từ 30 phút — browser stable)

// Map account_id -> { browser, context, storageFile, lastUsed, closing, busy, createdAt }
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
    const age = Date.now() - existing.createdAt
    const needsRecycle = existing.jobCount >= MAX_JOBS_PER_SESSION || age >= MAX_SESSION_AGE_MS

    if (needsRecycle && !existing.busy) {
      // Session served too many jobs or too old — recycle to prevent memory leaks
      console.log(`[SESSION-POOL] ♻️ Recycling ${account.username || id} (jobs: ${existing.jobCount}/${MAX_JOBS_PER_SESSION}, age: ${Math.round(age / 60000)}min)`)
      await closeSession(id)
      // Fall through to create new session below
    } else {
      // Check context còn sống không
      try {
        const pages = existing.context.pages()
        existing.lastUsed = Date.now()
        existing.jobCount++
        console.log(`[SESSION-POOL] Reusing session for ${account.username || id} (${pages.length} tabs, job #${existing.jobCount})`)
        return existing
      } catch {
        // Browser/context đã chết, xóa và tạo mới
        console.log(`[SESSION-POOL] Session dead for ${account.username || id}, recreating...`)
        sessions.delete(id)
      }
    }
  }

  // Evict TRƯỚC khi tạo session mới (tránh vượt MAX_SESSIONS)
  if (sessions.size >= MAX_SESSIONS) {
    // Cross-check NickPool for sessions that have a running job — never evict those.
    // This prevents the bug where a 2nd job evicts the 1st mid-execution.
    const nickPool = (typeof globalThis !== 'undefined') ? globalThis.__socialflowNickPool : null
    let oldestId = null, oldestTime = Infinity
    for (const [sid, s] of sessions) {
      if (s.busy || s.closing) continue
      if (nickPool && nickPool.hasRunningJob(sid)) continue // poller still has a job using this nick
      if (s.lastUsed < oldestTime) {
        oldestTime = s.lastUsed
        oldestId = sid
      }
    }
    if (oldestId) {
      console.log(`[SESSION-POOL] At max ${MAX_SESSIONS} sessions, evicting idle ${oldestId.slice(0, 8)} BEFORE creating new`)
      await closeSession(oldestId)
      // Đợi process thực sự thoát
      await new Promise(r => setTimeout(r, 2000))
    } else {
      // No evictable session — caller must back off and retry later.
      // Returning null is safer than creating a 2nd browser (breaks MAX_SESSIONS contract).
      console.warn(`[SESSION-POOL] ⚠️ All ${MAX_SESSIONS} session(s) busy — cannot create new for ${account.username || id}, will retry`)
      const err = new Error('SESSION_POOL_BUSY')
      err.code = 'SESSION_POOL_BUSY'
      throw err
    }
  }

  // Tạo session mới
  const headlessLabel = opts.headless ? ' (headless)' : ''
  console.log(`[SESSION-POOL] Creating new session for ${account.username || id}${headlessLabel} (${sessions.size}/${MAX_SESSIONS} active)`)
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
    isPersistent: true, // launchPersistentContext — browser data tách riêng mỗi nick
    lastUsed: Date.now(),
    createdAt: Date.now(),
    closing: false,
    busy: false,
    jobCount: 0, // Track jobs served — recycle after MAX_JOBS_PER_SESSION
  }

  sessions.set(id, entry)
  startCleanup()
  return entry
}

// Per-account lock to prevent concurrent getPage for same nick
const sessionLocks = new Map()

/**
 * Tạo page mới với cookies từ account
 * @param {object} account - account record từ DB
 * @param {object} opts - { headless: boolean } - override headless mode
 */
async function getPage(account, opts = {}) {
  const id = account.id || account.account_id

  // Wait for any pending getPage for this account (prevent concurrent access)
  while (sessionLocks.has(id)) {
    await sessionLocks.get(id)
  }
  let lockResolve
  sessionLocks.set(id, new Promise(r => { lockResolve = r }))

  try {
  return await _getPageInternal(account, opts)
  } finally {
    sessionLocks.delete(id)
    lockResolve()
  }
}

async function _getPageInternal(account, opts = {}) {
  let session = await getSession(account, opts)
  const id = account.id || account.account_id
  session.busy = true

  // ── SINGLE TAB REUSE — KHÔNG BAO GIỜ đóng/mở tab ──
  // Đóng/mở tab liên tục = Facebook detect → checkpoint
  // Luôn tái sử dụng tab đầu tiên, navigate trên đó
  let page = null
  try {
    const pages = session.context.pages()
    // Lấy tab đầu tiên còn sống — KHÔNG đóng tab nào
    page = pages.find(p => !p.isClosed()) || null
    if (page) {
      console.log(`[SESSION-POOL] ♻️ Reusing tab for ${account.username || id} (url: ${page.url().substring(0, 50)})`)
    }
  } catch {}

  // Chỉ tạo tab mới nếu KHÔNG có tab nào (lần đầu launch)
  if (!page) {
    try {
      page = await session.context.newPage()
      console.log(`[SESSION-POOL] Created first tab for ${account.username || id}`)
    } catch (err) {
      console.log(`[SESSION-POOL] newPage failed: ${err.message}, recreating session...`)
      sessions.delete(id)
      const fresh = await getSession(account, opts)
      session = fresh
      try {
        const freshPages = fresh.context.pages()
        page = freshPages.find(p => !p.isClosed()) || null
      } catch {}
      if (!page) page = await fresh.context.newPage()
    }
  }

  // Intercept popup tabs — redirect URL về tab chính thay vì mở tab mới
  if (!session._popupBlocked) {
    session.context.on('page', async (newPage) => {
      // Popup mở → lấy URL → navigate tab chính tới đó → đóng popup
      try {
        const popupUrl = newPage.url()
        console.log(`[SESSION-POOL] ⛔ Popup intercepted: ${popupUrl.substring(0, 60)} → redirecting main tab`)
        // Đóng popup NGAY, không để nó load
        await newPage.close()
        // Nếu URL là facebook → navigate tab chính tới đó
        if (popupUrl && popupUrl !== 'about:blank' && popupUrl.includes('facebook.com')) {
          const mainPage = session.context.pages().find(p => !p.isClosed())
          if (mainPage) await mainPage.goto(popupUrl, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {})
        }
      } catch {}
    })
    session._popupBlocked = true
  }

  // Set cookies — ONLY inject from DB if persistent context has NO Facebook cookies
  // Persistent context saves cookies in Default/Network/Cookies automatically
  // If we inject old DB cookies on top → overwrites fresh xs token → session death!
  if (account.cookie_string && !session._cookiesInjected) {
    // Check if persistent context already has valid Facebook cookies
    let hasExistingCookies = false
    try {
      const existing = await session.context.cookies(['https://www.facebook.com'])
      const hasXs = existing.some(c => c.name === 'xs' && c.value.length > 5)
      const hasCUser = existing.some(c => c.name === 'c_user' && c.value.length > 3)
      hasExistingCookies = hasXs && hasCUser
      if (hasExistingCookies) {
        console.log(`[SESSION-POOL] ✅ Persistent context has valid FB cookies — NOT injecting from DB (preserving fresh xs)`)
      }
    } catch {}

    if (!hasExistingCookies) {
      // First time or cookies cleared — inject from DB
      // SAFETY: Verify c_user in cookie matches account's fb_user_id
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

      // Validate: c_user must match fb_user_id (prevent cross-nick cookie injection)
      const cUserCookie = cookies.find(c => c.name === 'c_user')
      if (cUserCookie && account.fb_user_id && account.fb_user_id !== '0') {
        if (cUserCookie.value !== account.fb_user_id) {
          console.error(`[SESSION-POOL] ❌ COOKIE MISMATCH: c_user=${cUserCookie.value} but fb_user_id=${account.fb_user_id} for ${account.username || id} — NOT injecting!`)
          session._cookiesInjected = true // don't try again
          return { page, session }
        }
      }

      // Validate: must have both c_user and xs
      const hasXsCookie = cookies.some(c => c.name === 'xs' && c.value.length > 5)
      const hasCUserCookie = cookies.some(c => c.name === 'c_user' && c.value.length > 3)
      if (!hasXsCookie || !hasCUserCookie) {
        console.warn(`[SESSION-POOL] ⚠️ DB cookies incomplete for ${account.username || id} (c_user: ${hasCUserCookie}, xs: ${hasXsCookie}) — skipping injection`)
        session._cookiesInjected = true
        return { page, session }
      }
      await session.context.addCookies(cookies)
      console.log(`[SESSION-POOL] 🍪 Cookies injected from DB for ${account.username || account.id} (${cookies.length} cookies — first time)`)
    }
    session._cookiesInjected = true
  }

  // Warmup: navigate FB nếu page đang blank hoặc chưa ở facebook
  const currentUrl = page.url()
  const needsWarmup = !currentUrl || currentUrl === 'about:blank' || !currentUrl.includes('facebook.com')
  if (needsWarmup) {
    try {
      console.log(`[SESSION-POOL] Warming up ${account.username || id} (was: ${currentUrl})`)
      await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 30000 })
      // Random wait 1.5-3s — không fix cứng
      await page.waitForTimeout(1500 + Math.floor(Math.random() * 1500))
      const url = page.url()
      if (url.includes('/login') || url.includes('checkpoint')) {
        console.warn(`[SESSION-POOL] ⚠️ Not logged in: ${account.username || id} → ${url}`)
        // Mark session as problematic for error classification
        session._loginFailed = true
        // Record early warning signal
        try {
          const { checkRedirectWarn } = require('../lib/signal-collector')
          checkRedirectWarn(id, null, 'https://www.facebook.com/', url)
        } catch {}
      }
    } catch (err) {
      console.warn(`[SESSION-POOL] Warmup failed for ${account.username || id}: ${err.message}`)
    }
  }

  // Dismiss any lingering dialogs from previous job (e.g. open composer)
  try {
    const hasDialog = await page.locator('[role="dialog"]').first().isVisible({ timeout: 500 }).catch(() => false)
    if (hasDialog) {
      await page.keyboard.press('Escape')
      await page.waitForTimeout(300)
    }
  } catch {}

  // Periodic cookie save — protect against crash losing xs rotation
  // Saves every 15 min while session is active. Cleared on release.
  if (!session._cookieSaveInterval && session.context) {
    session._cookieSaveInterval = setInterval(async () => {
      try {
        const cookies = await session.context.cookies('https://www.facebook.com')
        const cUser = cookies.find(c => c.name === 'c_user')
        const xs = cookies.find(c => c.name === 'xs')
        if (cUser?.value && xs?.value) {
          const critical = cookies.filter(c => ['c_user', 'xs', 'datr', 'sb', 'fr'].includes(c.name) && c.value.length > 0)
          const cookieStr = critical.map(c => `${c.name}=${c.value}`).join('; ')
          const { supabase: sb } = require('../lib/supabase')
          await sb.from('accounts').update({
            cookie_string: cookieStr,
            last_used_at: new Date().toISOString(),
          }).eq('id', id)
          console.log(`[SESSION-POOL] 🔄 Periodic cookie save for ${account.username || id}`)
        }
      } catch {}
    }, 15 * 60 * 1000)
  }

  return { page, session }
}

/**
 * Đánh dấu session idle + SAVE cookies để xs token không bị stale
 * xs cookie refresh mỗi 30-40 phút — nếu không save → lần sau bị đá
 */
async function releaseSession(accountId, supabase) {
  const session = sessions.get(accountId)
  if (session) {
    // Clear periodic cookie save interval
    if (session._cookieSaveInterval) {
      clearInterval(session._cookieSaveInterval)
      session._cookieSaveInterval = null
    }
    session.lastUsed = Date.now()
    session.busy = false

    // Save updated cookies back to DB — critical for xs token rotation
    // SAFETY: only save if c_user AND xs both present and non-empty
    // If session is on login page → cookies are empty → DO NOT overwrite DB
    if (supabase) {
      try {
        const cookies = await session.context.cookies(['https://www.facebook.com'])
        const cUser = cookies.find(c => c.name === 'c_user' && c.value.length > 3)
        const xs = cookies.find(c => c.name === 'xs' && c.value.length > 5)

        if (cUser && xs) {
          const critical = cookies.filter(c => ['c_user', 'xs', 'datr', 'sb', 'fr'].includes(c.name) && c.value.length > 0)
          const cookieStr = critical.map(c => `${c.name}=${c.value}`).join('; ')
          await supabase.from('accounts').update({
            cookie_string: cookieStr,
            last_used_at: new Date().toISOString(),
          }).eq('id', accountId)
          console.log(`[SESSION-POOL] 🍪 Cookies saved for ${accountId.slice(0, 8)} (${critical.map(c => c.name).join(', ')})`)
        } else {
          // Session is logged out — mark account inactive + notify user
          console.warn(`[SESSION-POOL] ⚠️ No valid c_user/xs for ${accountId.slice(0, 8)} — session expired, disabling nick`)
          await supabase.from('accounts').update({
            status: 'expired',
            is_active: false,                      // stop scheduling new jobs
            last_used_at: new Date().toISOString(),
          }).eq('id', accountId)

          // Fetch owner_id + username for notification
          try {
            const { data: acct } = await supabase.from('accounts')
              .select('owner_id, username').eq('id', accountId).single()
            if (acct?.owner_id) {
              // Dedup: only notify once per account per 24h
              const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
              const { data: recent } = await supabase.from('notifications')
                .select('id')
                .eq('user_id', acct.owner_id)
                .eq('type', 'session_expired')
                .gte('created_at', since)
                .like('body', `%${accountId.slice(0, 8)}%`)
                .limit(1)

              if (!recent?.length) {
                await supabase.from('notifications').insert({
                  user_id: acct.owner_id,
                  type: 'session_expired',
                  title: `Nick "${acct.username || accountId.slice(0, 8)}" cookie hết hạn`,
                  body: `Nick ${accountId.slice(0, 8)} đã bị đăng xuất khỏi Facebook. Cập nhật cookie mới qua Edit Account để dùng lại.`,
                  level: 'warning',
                  data: { account_id: accountId, reason: 'session_expired' },
                })
              }
            }
          } catch (notifErr) {
            console.warn(`[SESSION-POOL] Could not create notification: ${notifErr.message}`)
          }
        }
      } catch (err) {
        console.warn(`[SESSION-POOL] Cookie save failed for ${accountId.slice(0, 8)}: ${err.message}`)
      }
    }
  }
}

/**
 * Đóng session thật + save cookies
 */
async function closeSession(accountId) {
  const session = sessions.get(accountId)
  if (!session || session.closing) return

  session.closing = true
  if (session._cookieSaveInterval) {
    clearInterval(session._cookieSaveInterval)
    session._cookieSaveInterval = null
  }
  const label = accountId.slice(0, 8)
  console.log(`[SESSION-POOL] Closing session for ${label} (jobs served: ${session.jobCount})`)

  try {
    // Save cookies BEFORE closing — but ONLY if session is still logged in
    try {
      const cookies = await session.context.cookies(['https://www.facebook.com'])
      const cUser = cookies.find(c => c.name === 'c_user' && c.value.length > 3)
      const xs = cookies.find(c => c.name === 'xs' && c.value.length > 5)
      if (cUser && xs) {
        const critical = cookies.filter(c => ['c_user', 'xs', 'datr', 'sb'].includes(c.name) && c.value.length > 0)
        const fs = require('fs')
        const cookieData = JSON.stringify({ cookies: critical })
        fs.writeFileSync(session.storageFile, cookieData)
        console.log(`[SESSION-POOL] 🍪 Cookies preserved to disk for ${label} before close`)
      } else {
        console.warn(`[SESSION-POOL] ⚠️ Session ${label} has no valid cookies — NOT saving to disk`)
      }
    } catch {}

    // Close context trực tiếp — KHÔNG đóng từng page (tránh trigger FB detection)
    // Persistent context: close context = close browser
    await session.context.close().catch(() => {})
    // Force kill browser process if still alive
    if (session.browser?.process?.()) {
      try { session.browser.process().kill('SIGKILL') } catch {}
    }
  } catch (err) {
    console.warn(`[SESSION-POOL] Close error for ${label}: ${err.message}`)
  }

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
    if (session.closing) continue

    const idle = now - session.lastUsed > IDLE_TIMEOUT_MS
    const tooOld = now - session.createdAt > MAX_SESSION_AGE_MS
    const tooManyJobs = session.jobCount >= MAX_JOBS_PER_SESSION

    if ((idle || tooOld || tooManyJobs) && !session.busy) {
      const reason = idle ? 'idle' : tooOld ? 'max age' : 'max jobs'
      console.log(`[SESSION-POOL] ♻️ Cleanup ${id.slice(0, 8)}: ${reason} (jobs: ${session.jobCount}, age: ${Math.round((now - session.createdAt) / 60000)}min)`)
      closeSession(id)
    } else if (session.busy) {
      session.lastUsed = now // keep alive while busy
    }
  }

  // Log memory usage periodically
  const mem = process.memoryUsage()
  const heapMB = Math.round(mem.heapUsed / 1024 / 1024)
  const rssMB = Math.round(mem.rss / 1024 / 1024)
  if (rssMB > 500) {
    console.warn(`[SESSION-POOL] ⚠️ High memory: RSS=${rssMB}MB Heap=${heapMB}MB Sessions=${sessions.size}`)
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

function getSessionCount() {
  return sessions.size
}

module.exports = {
  getSession,
  getPage,
  releaseSession,
  closeSession,
  closeAll,
  getActiveSessions,
  getSessionCount,
  sessions,
}
