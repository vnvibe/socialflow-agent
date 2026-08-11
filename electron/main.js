const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain } = require('electron')
const path = require('path')
const { fork, execSync, spawn } = require('child_process')
const fs = require('fs')
const { checkForUpdate, pullUpdate, getLocalVersion } = require(path.join(__dirname, '..', 'lib', 'updater'))

// ── sslip.io DNS Fallback ──
const dns = require('dns')
const originalLookup = dns.lookup
dns.lookup = function (hostname, options, callback) {
  if (hostname === '103-142-24-60.sslip.io') {
    if (typeof options === 'function') {
      callback = options
      options = {}
    }
    const ip = '103.142.24.60'
    const family = 4
    if (options && options.all) {
      return callback(null, [{ address: ip, family }])
    }
    return callback(null, ip, family)
  }
  return originalLookup.call(dns, hostname, options, callback)
}

let mainWindow = null
let tray = null
let agentProcess = null
let isQuitting = false
let logs = []
let userSession = null  // { id, email, access_token }
const MAX_LOGS = 500

// Paths
const isPackaged = !process.defaultApp
// electron-builder puts asarUnpack files in app.asar.unpacked (real filesystem path)
// fork() needs a real path — app.asar is virtual and cannot be used as cwd/script path
const appRoot = isPackaged
  ? (() => {
      const unpacked = path.join(process.resourcesPath, 'app.asar.unpacked')
      return fs.existsSync(unpacked) ? unpacked : path.join(process.resourcesPath, 'app')
    })()
  : path.join(__dirname, '..')

process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(appRoot, 'ms-playwright')

let agentConfig = {}
try { agentConfig = require(path.join(appRoot, 'lib', 'config')) } catch {}
const API_URL = process.env.API_URL || agentConfig.API_URL || 'https://103-142-24-60.sslip.io'
const AGENT_SECRET = process.env.AGENT_SECRET || process.env.AGENT_SECRET_KEY || agentConfig.AGENT_SECRET_KEY || ''

// ── Persistent session (so user doesn't re-login every restart) ──
// Use auth.json for backward-compat with older builds that wrote there.
// Lazy-compute path inside functions — app.getPath('userData') can return
// different value before vs after app.whenReady() in some Electron builds.
function getSessionFile() {
  const dir = app.getPath('userData')
  try { fs.mkdirSync(dir, { recursive: true }) } catch {}
  return path.join(dir, 'auth.json')
}

function loadSession() {
  const file = getSessionFile()
  try {
    if (!fs.existsSync(file)) {
      console.log('[SESSION] no file at', file)
      return null
    }
    const raw = fs.readFileSync(file, 'utf8')
    const parsed = JSON.parse(raw)
    // Support both old shape ({token, user:{id,email,...}})
    // and new shape ({id, email, access_token})
    const id = parsed.id || parsed.user?.id
    const email = parsed.email || parsed.user?.email
    const access_token = parsed.access_token || parsed.token
    if (!id || !email || !access_token) {
      console.log('[SESSION] file present but missing fields')
      return null
    }
    console.log('[SESSION] loaded for', email, 'from', file)
    return { id, email, access_token }
  } catch (err) {
    console.error('[SESSION] load failed:', err.message)
    return null
  }
}

function saveSession(session) {
  const file = getSessionFile()
  // Write in legacy shape too so any older code that reads `token` / `user.email` still works.
  const payload = {
    id: session.id,
    email: session.email,
    access_token: session.access_token,
    token: session.access_token,
    user: { id: session.id, email: session.email },
  }
  try {
    fs.writeFileSync(file, JSON.stringify(payload, null, 2))
    console.log('[SESSION] saved', session.email, '→', file)
  } catch (err) {
    console.error('[SESSION] save failed:', err.message, 'path:', file)
    addLog(`Không lưu được session: ${err.message}`, 'warn')
  }
}

function clearSession() {
  const file = getSessionFile()
  try {
    if (fs.existsSync(file)) {
      fs.unlinkSync(file)
      console.log('[SESSION] cleared')
    }
  } catch {}
}

// Synchronously hydrate userSession from disk — UI shows logged-in state immediately
function hydrateSessionSync() {
  const saved = loadSession()
  if (saved?.access_token && saved.email) {
    userSession = saved
    return true
  }
  return false
}

// Validate token in background. Only clear session on 401/403 (token actually
// invalid). Network errors / 5xx → keep cached session, user can keep working.
async function validateSessionAsync() {
  if (!userSession?.access_token) return
  try {
    const res = await fetch(`${API_URL}/auth/me`, {
      headers: { Authorization: `Bearer ${userSession.access_token}` },
    })
    if (res.ok) {
      console.log('[SESSION] token valid for', userSession.email)
      return
    }
    if (res.status === 401 || res.status === 403) {
      addLog('Phiên hết hạn, vui lòng đăng nhập lại', 'warn')
      userSession = null
      clearSession()
      updateTray()
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('user', null)
      }
    } else {
      console.warn('[SESSION] /auth/me returned', res.status, '— keeping cached session')
    }
  } catch (err) {
    console.warn('[SESSION] validate failed (network), keeping cached session:', err.message)
  }
}

function addLog(line, type = 'info') {
  const entry = { time: new Date().toISOString(), text: line, type }
  logs.push(entry)
  if (logs.length > MAX_LOGS) logs.shift()
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('log', entry)
  }
}

// Check if Playwright Chromium is installed (lazy — only called on Start)
async function ensurePlaywright() {
  addLog('Checking Playwright Chromium launch...', 'info')
  let playwrightInstance = null
  try {
    playwrightInstance = require('playwright')
  } catch (err) {
    try {
      playwrightInstance = require(path.join(appRoot, 'node_modules', 'playwright'))
    } catch (e) {}
  }

  if (playwrightInstance) {
    try {
      const browser = await playwrightInstance.chromium.launch({ headless: true })
      await browser.close()
      addLog('Playwright Chromium ready', 'success')
      return true
    } catch (err) {
      addLog(`Playwright Chromium launch test failed: ${err.message}`, 'warn')
    }
  }

  // Need to install
  addLog('Installing Playwright browsers (first run, ~150MB)...', 'warn')
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('setup-progress', 'Installing Chromium browser...')
  }

  return new Promise((resolve) => {
    const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx'
    const shellEnv = {
      SystemRoot: process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\\Windows',
      PATH: process.env.PATH || process.env.Path || '',
      Path: process.env.PATH || process.env.Path || '',
      COMSPEC: process.env.COMSPEC || process.env.ComSpec || 'cmd.exe',
      ComSpec: process.env.COMSPEC || process.env.ComSpec || 'cmd.exe',
      ...process.env
    }
    const child = spawn(npx, ['playwright', 'install'], {
      cwd: fs.existsSync(appRoot) ? appRoot : (process.resourcesPath || process.cwd()),
      env: shellEnv,
      shell: true,
    })

    child.stdout.on('data', (d) => addLog(d.toString().trim(), 'info'))
    child.stderr.on('data', (d) => {
      const msg = d.toString().trim()
      if (msg) addLog(msg, 'warn')
    })

    child.on('error', (err) => {
      addLog(`Failed to start installation: ${err.message}`, 'error')
      resolve(false)
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('setup-progress', null)
      }
    })

    child.on('close', (code) => {
      if (code === 0) {
        addLog('Chromium installed successfully', 'success')
        resolve(true)
      } else {
        addLog('Chromium install failed — agent may not work', 'error')
        resolve(false)
      }
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('setup-progress', null)
      }
    })
  })
}

// ── Giám sát vòng đời agent ──
// agentShouldRun = TRẠNG THÁI NGƯỜI DÙNG MUỐN (bấm Chạy/Dừng), tách khỏi
// trạng thái tiến trình thực tế. Trước đây chỉ có agentProcess: agent chết vì
// uncaughtException (agent.js gọi process.exit ở handler) là nằm im luôn, dù
// người dùng đã bấm Chạy — nhìn như "tự ý dừng".
let agentShouldRun = false
let agentRestartCount = 0
let agentRestartTimer = null
const AGENT_MAX_RESTARTS = 10          // đủ để vượt lỗi tạm thời, không lặp vô hạn
const AGENT_RESTART_WINDOW_MS = 10 * 60 * 1000  // reset bộ đếm sau 10 phút chạy ổn
let agentStartedAt = 0

function clearAgentRestartTimer() {
  if (agentRestartTimer) { clearTimeout(agentRestartTimer); agentRestartTimer = null }
}

function startAgent() {
  if (agentProcess) return

  const agentPath = path.join(appRoot, 'agent.js')

  if (!fs.existsSync(agentPath)) {
    addLog(`agent.js not found at: ${agentPath}`, 'error')
    return
  }

  // Load .env if exists (optional — config.js has embedded credentials from build)
  const envVars = {}
  let envPath = path.join(appRoot, '.env')
  if (!fs.existsSync(envPath) && isPackaged) {
    const prodEnv = path.join(process.resourcesPath, '..', '.env')
    if (fs.existsSync(prodEnv)) {
      envPath = prodEnv
    }
  }
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf8').split('\n')
    for (const line of lines) {
      const match = line.match(/^\s*([^#=]+?)\s*=\s*(.*)$/)
      if (match) envVars[match[1]] = match[2].trim()
    }
  }
  if (agentConfig.HEADLESS && !envVars.HEADLESS) {
    envVars.HEADLESS = agentConfig.HEADLESS
  }

  agentProcess = fork(agentPath, [], {
    cwd: appRoot,
    env: {
      ...process.env,
      PLAYWRIGHT_BROWSERS_PATH: path.join(appRoot, 'ms-playwright'),
      ...envVars,
      ...(userSession && {
        AGENT_USER_ID: userSession.id,
        AGENT_USER_EMAIL: userSession.email,
      }),
    },
    silent: true,
  })

  agentProcess.stdout.on('data', (data) => {
    const lines = data.toString().split('\n').filter(Boolean)
    lines.forEach(line => {
      const type = line.includes('[ERROR]') || line.includes('Error') ? 'error'
        : line.includes('[WARN]') ? 'warn'
        : line.includes('[OK]') ? 'success'
        : 'info'
      addLog(line, type)
    })
  })

  agentProcess.stderr.on('data', (data) => {
    data.toString().split('\n').filter(Boolean).forEach(line => addLog(line, 'error'))
  })

  agentProcess.on('exit', (code) => {
    agentProcess = null

    // Người dùng đã bấm Dừng → tôn trọng, KHÔNG khởi động lại.
    if (!agentShouldRun) {
      addLog(`Agent đã dừng (mã: ${code})`, 'info')
      updateTray()
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('status', { running: false })
      }
      return
    }

    // Chạy ổn định đủ lâu rồi mới chết → coi như sự cố mới, reset bộ đếm
    if (agentStartedAt && Date.now() - agentStartedAt > AGENT_RESTART_WINDOW_MS) {
      agentRestartCount = 0
    }

    if (agentRestartCount >= AGENT_MAX_RESTARTS) {
      agentShouldRun = false
      addLog(`Agent chết ${agentRestartCount} lần liên tiếp — đã ngừng tự khởi động lại. Kiểm tra log lỗi rồi bấm Chạy lại.`, 'error')
      updateTray()
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('status', { running: false })
      }
      return
    }

    agentRestartCount++
    const delay = Math.min(30000, 2000 * agentRestartCount)  // 2s, 4s, 6s… tối đa 30s
    addLog(`Agent thoát ngoài ý muốn (mã: ${code}) — tự khởi động lại sau ${Math.round(delay / 1000)}s (lần ${agentRestartCount}/${AGENT_MAX_RESTARTS})`, 'warn')
    // Giữ trạng thái "đang chạy" trên UI: người dùng vẫn muốn chạy, chỉ là đang hồi phục
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('status', { running: true, recovering: true })
    }
    clearAgentRestartTimer()
    agentRestartTimer = setTimeout(() => {
      agentRestartTimer = null
      if (agentShouldRun && !agentProcess) startAgent()
    }, delay)
  })

  agentStartedAt = Date.now()
  addLog('Agent đã khởi động', 'success')
  updateTray()
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('status', { running: true })
  }
}

function stopAgent() {
  // Đặt ý định TRƯỚC khi kill, để handler 'exit' không tự khởi động lại
  agentShouldRun = false
  agentRestartCount = 0
  clearAgentRestartTimer()

  if (!agentProcess) {
    // Đã chết sẵn — vẫn phải đồng bộ UI về trạng thái dừng
    updateTray()
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('status', { running: false })
    }
    return
  }

  const proc = agentProcess
  proc.kill('SIGTERM')
  setTimeout(() => {
    // Chỉ SIGKILL đúng tiến trình đó, tránh giết nhầm tiến trình mới
    if (agentProcess === proc) {
      try { proc.kill('SIGKILL') } catch {}
      agentProcess = null
      updateTray()
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('status', { running: false })
      }
    }
  }, 5000)
}

function createWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show()
    mainWindow.focus()
    return
  }

  mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    minWidth: 600,
    minHeight: 400,
    title: 'SocialFlow Agent',
    icon: path.join(__dirname, 'icon.png'),
    show: true,
    backgroundColor: '#0f172a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  mainWindow.loadFile(path.join(__dirname, 'index.html'))
  mainWindow.setMenuBarVisibility(false)

  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault()
      mainWindow.hide()
    }
  })
}

function updateTray() {
  if (!tray) return
  const running = !!agentProcess
  const contextMenu = Menu.buildFromTemplate([
    { label: `SocialFlow Agent — ${running ? 'Running' : 'Stopped'}`, enabled: false },
    { type: 'separator' },
    { label: 'Open', click: createWindow },
    {
      label: running ? 'Stop Agent' : 'Start Agent',
      click: () => running ? stopAgent() : startAgent()
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        isQuitting = true
        stopAgent()
        setTimeout(() => app.quit(), 1500)
      }
    },
  ])
  tray.setContextMenu(contextMenu)
  tray.setToolTip(`SocialFlow Agent — ${running ? 'Running' : 'Stopped'}`)
}

function createTray() {
  const iconPath = path.join(__dirname, 'icon.png')
  let icon
  if (fs.existsSync(iconPath)) {
    icon = nativeImage.createFromPath(iconPath)
    icon = icon.resize({ width: 16, height: 16 })
  } else {
    icon = nativeImage.createEmpty()
  }
  tray = new Tray(icon)
  tray.on('double-click', createWindow)
  updateTray()
}

// IPC handlers
ipcMain.handle('get-status', () => ({ running: !!agentProcess }))
ipcMain.handle('get-logs', () => logs)
ipcMain.handle('get-user', () => userSession)
ipcMain.handle('start-agent', async () => {
  if (!userSession) return { error: 'Chưa đăng nhập' }
  // Ghi nhận ý định TRƯỚC khi chuẩn bị Playwright: nếu người dùng bấm Dừng
  // trong lúc đang cài Chromium, ý định đó phải thắng.
  agentShouldRun = true
  agentRestartCount = 0
  clearAgentRestartTimer()
  await ensurePlaywright()
  if (!agentShouldRun) return true   // đã bị bấm Dừng trong lúc chờ
  startAgent()
  return true
})
ipcMain.handle('stop-agent', () => { stopAgent(); return true })
ipcMain.handle('clear-logs', () => { logs = []; return true })

// ── Báo cáo: lấy comment_logs + KPI hôm nay ──
// status = 'all' (default) → không filter status, trả mọi record
// status = 'done'/'pending'/'failed' → filter theo giá trị cụ thể
ipcMain.handle('get-report', async (_, { limit = 200, status = 'all', offset = 0 } = {}) => {
  if (!userSession?.id) return { error: 'Chưa đăng nhập' }
  try {
    const filters = [
      { type: 'eq', column: 'owner_id', value: userSession.id },
    ]
    // Chỉ thêm filter status khi không phải 'all'
    if (status && status !== 'all') {
      filters.push({ type: 'eq', column: 'status', value: status })
    }
    return await scoutDbQuery({
      op: 'select',
      table: 'comment_logs',
      cols: 'id,created_at,finished_at,account_id,source_name,post_url,comment_text,status,ai_generated,campaign_id,job_id,error_message',
      filters,
      options: { order: { column: 'created_at', ascending: false }, limit, offset }
    })
  } catch (err) { return { error: err.message } }
})

ipcMain.handle('get-kpi-today', async () => {
  if (!userSession?.id) return { error: 'Chưa đăng nhập' }
  try {
    // VN day UTC boundaries (GMT+7: 00:00 VN is 17:00 UTC previous day)
    const now = new Date()
    const vnNow = new Date(now.getTime() + 7 * 3600 * 1000)
    const vnTodayStr = vnNow.toISOString().slice(0, 10)
    
    // Start of VN day in UTC: e.g. 2026-07-29 00:00 VN = 2026-07-28 17:00:00 UTC
    const startOfDayUtc = new Date(Date.UTC(vnNow.getUTCFullYear(), vnNow.getUTCMonth(), vnNow.getUTCDate() - 1, 17, 0, 0)).toISOString()
    const endOfDayUtc = new Date(Date.UTC(vnNow.getUTCFullYear(), vnNow.getUTCMonth(), vnNow.getUTCDate(), 16, 59, 59, 999)).toISOString()

    return await scoutDbQuery({
      op: 'select',
      table: 'nick_kpi_daily',
      cols: 'id,account_id,campaign_id,date,target_comments,done_comments,target_likes,done_likes,kpi_met',
      filters: [
        { type: 'gte', column: 'date', value: startOfDayUtc },
        { type: 'lte', column: 'date', value: endOfDayUtc }
      ],
      options: { order: { column: 'done_comments', ascending: false }, limit: 50 }
    })
  } catch (err) { return { error: err.message } }
})



ipcMain.handle('login', async (_, { email, password }) => {
  try {
    const res = await fetch(`${API_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    })
    const data = await res.json()
    if (!res.ok) return { error: data.error || `HTTP ${res.status}` }
    userSession = { id: data.user.id, email: data.user.email, access_token: data.token }
    saveSession(userSession)
    addLog(`Đã đăng nhập: ${userSession.email}`, 'success')
    updateTray()
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('user', userSession)
    }
    return { user: { id: userSession.id, email: userSession.email } }
  } catch (err) {
    return { error: err.message }
  }
})

// Auto-update handlers
ipcMain.handle('apply-update', async () => {
  try {
    const { isGitRepo } = require(path.join(appRoot, 'lib', 'updater'))

    // Exe mode: open download page
    if (!isGitRepo()) {
      const { shell } = require('electron')
      shell.openExternal(`https://github.com/nguyentanviet92-pixel/socialflow/releases`)
      addLog('Đã mở trang tải bản mới...', 'info')
      // PHẢI phát update-result, nếu không nút "Cập nhật" ở UI kẹt vĩnh viễn
      // ở trạng thái disabled + "Đang cập nhật..." (renderer chờ sự kiện này để reset).
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('update-result', {
          success: false,
          message: 'Đã mở trang tải — vui lòng tải và cài thủ công',
        })
      }
      return { success: true, message: 'Đã mở trang tải xuống', method: 'http' }
    }

    // Git mode: pull update
    if (agentProcess) {
      addLog('Đang tắt agent để cập nhật...', 'info')
      stopAgent()
      await new Promise(r => setTimeout(r, 2000))
    }

    addLog('Đang tải bản cập nhật...', 'info')
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('setup-progress', 'Đang cập nhật...')
    }

    const result = await pullUpdate()
    if (result.success) {
      addLog(`Cập nhật thành công: ${result.message}`, 'success')
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('setup-progress', null)
        mainWindow.webContents.send('update-result', { success: true, message: result.message })
      }
      setTimeout(() => { app.relaunch(); app.exit(0) }, 1500)
      return result
    } else {
      addLog(`Cập nhật thất bại: ${result.message}`, 'error')
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('setup-progress', null)
        mainWindow.webContents.send('update-result', { success: false, message: result.message })
      }
      return result
    }
  } catch (err) {
    addLog(`Lỗi cập nhật: ${err.message}`, 'error')
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('setup-progress', null)
    }
    return { success: false, message: err.message }
  }
})

ipcMain.handle('get-version', () => {
  return getLocalVersion() || require(path.join(appRoot, 'package.json')).version
})

ipcMain.handle('logout', () => {
  if (agentProcess) stopAgent()
  userSession = null
  clearSession()
  addLog('Đã đăng xuất', 'info')
  updateTray()
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('user', null)
  }
  return true
})

// Single instance lock — prevent multiple agent windows
// ========== SCOUT (Do Thám) ==========

function parseGroupIdFromUrl(url) {
  if (!url) return null
  const m = url.match(/groups\/(\d+)/) || url.match(/groups\/([^/?]+)/)
  return m ? m[1] : null
}

async function scoutDbQuery(body) {
  const res = await fetch(`${API_URL}/agent-db/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Agent-Key': AGENT_SECRET },
    body: JSON.stringify(body)
  })
  const json = await res.json()
  if (!res.ok) throw new Error(json.error?.message || json.error || `HTTP ${res.status}`)
  return json
}

ipcMain.handle('scout-get-targets', async () => {
  if (!userSession?.id) return { error: 'Chưa đăng nhập' }
  try {
    return await scoutDbQuery({
      op: 'select', table: 'scout_targets', cols: '*',
      filters: [{ type: 'eq', column: 'user_id', value: userSession.id }],
      options: { order: { column: 'created_at', ascending: false } }
    })
  } catch (err) { return { error: err.message } }
})

ipcMain.handle('scout-add-target', async (_, { name, fb_group_url, fb_group_id, scan_interval_hours }) => {
  if (!userSession?.id) return { error: 'Chưa đăng nhập' }
  try {
    const groupId = fb_group_id || parseGroupIdFromUrl(fb_group_url)
    if (!groupId) return { error: 'Không thể xác định Group ID từ URL' }
    const existing = await scoutDbQuery({
      op: 'select', table: 'scout_targets', cols: 'id',
      filters: [
        { type: 'eq', column: 'user_id', value: userSession.id },
        { type: 'eq', column: 'fb_group_id', value: groupId }
      ],
      options: { limit: 1 }
    })
    if (existing.data && existing.data.length > 0) return { error: 'Nhóm này đã được thêm rồi' }
    return await scoutDbQuery({
      op: 'insert', table: 'scout_targets',
      rows: [{ user_id: userSession.id, name: name || `Nhóm ${groupId}`, fb_group_id: groupId, fb_group_url: fb_group_url || '', scan_interval_hours: scan_interval_hours || 6, is_active: true }]
    })
  } catch (err) { return { error: err.message } }
})

ipcMain.handle('scout-update-target', async (_, { id, name, is_active, scan_interval_hours }) => {
  if (!userSession?.id) return { error: 'Chưa đăng nhập' }
  try {
    const updates = {}
    if (name !== undefined) updates.name = name
    if (is_active !== undefined) updates.is_active = is_active
    if (scan_interval_hours !== undefined) updates.scan_interval_hours = scan_interval_hours
    return await scoutDbQuery({
      op: 'update', table: 'scout_targets', updates,
      filters: [
        { type: 'eq', column: 'id', value: id },
        { type: 'eq', column: 'user_id', value: userSession.id }
      ]
    })
  } catch (err) { return { error: err.message } }
})

ipcMain.handle('scout-delete-target', async (_, { id }) => {
  if (!userSession?.id) return { error: 'Chưa đăng nhập' }
  try {
    return await scoutDbQuery({
      op: 'delete', table: 'scout_targets',
      filters: [
        { type: 'eq', column: 'id', value: id },
        { type: 'eq', column: 'user_id', value: userSession.id }
      ]
    })
  } catch (err) { return { error: err.message } }
})

ipcMain.handle('scout-get-posts', async (_, filters) => {
  if (!userSession?.id) return { error: 'Chưa đăng nhập' }
  try {
    const f = [{ type: 'eq', column: 'user_id', value: userSession.id }]
    if (filters?.target_id) f.push({ type: 'eq', column: 'scout_target_id', value: filters.target_id })
    return await scoutDbQuery({
      op: 'select', table: 'scout_posts', cols: '*',
      filters: f,
      options: { order: { column: 'scanned_at', ascending: false }, limit: filters?.limit || 20, offset: filters?.offset || 0 }
    })
  } catch (err) { return { error: err.message } }
})

ipcMain.handle('scout-get-comments', async (_, filters) => {
  if (!userSession?.id) return { error: 'Chưa đăng nhập' }
  try {
    return await scoutDbQuery({
      op: 'select', table: 'scout_comments', cols: '*',
      filters: [
        { type: 'eq', column: 'user_id', value: userSession.id },
        { type: 'eq', column: 'scout_post_id', value: filters?.post_id }
      ],
      options: { order: { column: 'scanned_at', ascending: true }, limit: filters?.limit || 50, offset: filters?.offset || 0 }
    })
  } catch (err) { return { error: err.message } }
})

ipcMain.handle('scout-get-logs', async (_, filters) => {
  if (!userSession?.id) return { error: 'Chưa đăng nhập' }
  try {
    return await scoutDbQuery({
      op: 'select', table: 'scout_job_logs', cols: '*',
      filters: [{ type: 'eq', column: 'user_id', value: userSession.id }],
      options: { order: { column: 'started_at', ascending: false }, limit: filters?.limit || 20, offset: filters?.offset || 0 }
    })
  } catch (err) { return { error: err.message } }
})

// ========== CÀI ĐẶT AI (đa provider) ==========
// ai_settings là bảng CHÍNH THỨC mà orchestrator phía server đọc khi sinh nội dung
// (api/src/services/ai/orchestrator.js → getFunctionConfig). Trước đây UI ghi vào
// hermes_config.config.ai — một chỗ KHÔNG ai đọc, nên cấu hình không có tác dụng gì.
// Giờ proxy thẳng qua REST /ai/settings (đã có sẵn che key) và /ai/test.

async function aiSettingsFetch(method, body) {
  const res = await fetch(`${API_URL}/ai/settings`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${userSession.access_token}`,
    },
    ...(body && { body: JSON.stringify(body) }),
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`)
  return json
}

ipcMain.handle('ai-get-config', async () => {
  if (!userSession) return { error: 'Chưa đăng nhập' }
  try {
    const s = await aiSettingsFetch('GET')
    const providers = {}
    for (const [name, p] of Object.entries(s.providers || {})) {
      providers[name] = {
        base_url: p.base_url || '',
        default_model: p.model || p.default_model || '',
        enabled: p.enabled !== false,
        has_key: !!p.api_key,
        key_masked: p.api_key || null,   // server đã che sẵn dạng "abcdefgh..."
      }
    }
    return { data: { providers, tasks: s.task_models || {}, fallback_chain: s.fallback_chain || [] } }
  } catch (err) { return { error: err.message } }
})

ipcMain.handle('ai-save-config', async (_, incoming) => {
  if (!userSession) return { error: 'Chưa đăng nhập' }
  try {
    const providers = {}
    for (const [name, p] of Object.entries((incoming && incoming.providers) || {})) {
      providers[name] = {
        base_url: p.base_url || '',
        model: p.default_model || '',
        enabled: p.enabled !== false,
        // Để trống = giữ key cũ. Server tự merge (xem PUT /ai/settings).
        api_key: (p.api_key && p.api_key.trim()) ? p.api_key.trim() : '',
      }
    }
    await aiSettingsFetch('PUT', {
      providers,
      task_models: (incoming && incoming.tasks) || {},
      fallback_chain: (incoming && incoming.fallback_chain) || [],
    })
    return { ok: true }
  } catch (err) { return { error: err.message } }
})

ipcMain.handle('ai-test-provider', async (_, p) => {
  if (!userSession) return { ok: false, message: 'Chưa đăng nhập' }
  try {
    const t0 = Date.now()
    const res = await fetch(`${API_URL}/ai/test`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${userSession.access_token}`,
      },
      // Key vừa gõ (chưa lưu) được ưu tiên; bỏ trống thì server lấy key trong DB.
      body: JSON.stringify({
        provider: p.name,
        ...(p.api_key && { api_key: p.api_key }),
        ...(p.model && { model: p.model }),
      }),
    })
    const json = await res.json().catch(() => ({}))
    if (!res.ok) return { ok: false, message: json.error || `HTTP ${res.status}` }
    // /ai/test trả HTTP 200 cả khi provider từ chối — lỗi thật nằm ở json.error.
    if (json.success === false) return { ok: false, message: json.error || 'Provider từ chối' }
    return {
      ok: true,
      latencyMs: Date.now() - t0,
      message: json.response || 'OK',
    }
  } catch (err) { return { ok: false, message: err.message } }
})

ipcMain.handle('ai-get-usage', async () => {
  if (!userSession) return { error: 'Chưa đăng nhập' }
  try {
    const since = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString()
    const res = await scoutDbQuery({
      op: 'select', table: 'ai_usage_log', cols: '*',
      filters: [
        { type: 'eq', column: 'user_id', value: userSession.id },
        { type: 'gte', column: 'created_at', value: since },
      ],
      options: { limit: 5000 }
    })
    // Gộp theo task_type + provider ở phía client (bảng chưa có view tổng hợp)
    const agg = {}
    for (const r of (res.data || [])) {
      const k = (r.task_type || '?') + '|' + (r.provider || '-')
      if (!agg[k]) agg[k] = { task_type: r.task_type, provider: r.provider, calls: 0, input_tokens: 0, output_tokens: 0, errors: 0 }
      agg[k].calls++
      agg[k].input_tokens += r.input_tokens || 0
      agg[k].output_tokens += r.output_tokens || 0
      if (r.ok === false) agg[k].errors++
    }
    return { data: Object.values(agg).sort((a, b) => b.calls - a.calls) }
  } catch (err) { return { error: err.message } }
})


// ========== CẤU HÌNH THEO TỪNG NICK ==========
// niche_profiles gắn theo account_id, KHÔNG phải theo user — nên mọi cấu hình
// ngách/quảng cáo/hạn mức phải chọn nick trước.

ipcMain.handle('nick-list', async () => {
  if (!userSession) return { error: 'Chưa đăng nhập' }
  try {
    const res = await scoutDbQuery({
      op: 'select', table: 'accounts',
      cols: 'id,username,fb_user_id,fb_created_at,is_active,status,created_at',
      filters: [{ type: 'eq', column: 'owner_id', value: userSession.id }],
      options: { order: { column: 'is_active', ascending: false }, limit: 200 },
    })
    return { data: res.data || [] }
  } catch (err) { return { error: err.message } }
})

ipcMain.handle('nick-config-get', async (_, accountId) => {
  if (!userSession) return { error: 'Chưa đăng nhập' }
  if (!accountId) return { error: 'Thiếu account_id' }
  try {
    const acc = await scoutDbQuery({
      op: 'select', table: 'accounts', cols: 'id,username,fb_user_id,fb_created_at,created_at',
      filters: [
        { type: 'eq', column: 'id', value: accountId },
        { type: 'eq', column: 'owner_id', value: userSession.id },  // chặn xem nick người khác
      ],
      options: { limit: 1 },
    })
    if (!acc.data || !acc.data.length) return { error: 'Không tìm thấy nick (hoặc không thuộc quyền bạn)' }

    const np = await scoutDbQuery({
      op: 'select', table: 'niche_profiles', cols: '*',
      filters: [{ type: 'eq', column: 'account_id', value: accountId }],
      options: { limit: 1 },
    })
    return { data: { account: acc.data[0], niche: (np.data && np.data[0]) || null } }
  } catch (err) { return { error: err.message } }
})

ipcMain.handle('nick-config-save', async (_, { accountId, account, niche }) => {
  if (!userSession) return { error: 'Chưa đăng nhập' }
  if (!accountId) return { error: 'Thiếu account_id' }
  try {
    // 1. Ngày tạo Facebook — quyết định warm-up. Chỉ ghi khi có giá trị.
    if (account && account.fb_created_at !== undefined) {
      await scoutDbQuery({
        op: 'update', table: 'accounts',
        updates: { fb_created_at: account.fb_created_at || null },
        filters: [
          { type: 'eq', column: 'id', value: accountId },
          { type: 'eq', column: 'owner_id', value: userSession.id },
        ],
      })
    }

    // 2. Hồ sơ ngách — upsert thủ công (bảng có UNIQUE(account_id))
    if (niche) {
      const row = {
        user_id: userSession.id,
        account_id: accountId,
        niche: niche.niche || null,
        persona: niche.persona || null,
        target_keywords: niche.target_keywords || [],
        negative_keywords: niche.negative_keywords || [],
        farming_enabled: !!niche.farming_enabled,
        posting_enabled: !!niche.posting_enabled,
        daily_likes: niche.daily_likes ?? 50,
        daily_comments: niche.daily_comments ?? 8,
        daily_posts: niche.daily_posts ?? 1,
        ad_enabled: !!niche.ad_enabled,
        brand_name: niche.brand_name || null,
        brand_description: niche.brand_description || null,
        products: niche.products || [],
        daily_ad_comments: niche.daily_ad_comments ?? 2,
        ad_min_score: niche.ad_min_score ?? 7,
        ad_style: niche.ad_style || 'soft',
        updated_at: new Date().toISOString(),
      }
      const exist = await scoutDbQuery({
        op: 'select', table: 'niche_profiles', cols: 'id',
        filters: [{ type: 'eq', column: 'account_id', value: accountId }],
        options: { limit: 1 },
      })
      if (exist.data && exist.data.length) {
        const { user_id, account_id, ...upd } = row
        await scoutDbQuery({
          op: 'update', table: 'niche_profiles', updates: upd,
          filters: [{ type: 'eq', column: 'account_id', value: accountId }],
        })
      } else {
        await scoutDbQuery({ op: 'insert', table: 'niche_profiles', rows: [row] })
      }
    }
    return { ok: true }
  } catch (err) { return { error: err.message } }
})

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    // Someone tried to open a second instance — focus existing window
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
    }
  })
}

// App lifecycle
app.whenReady().then(() => {
  // Hydrate session from disk SYNCHRONOUSLY before creating window
  // → renderer's initial getUser() returns the saved user immediately
  if (hydrateSessionSync()) {
    addLog(`Phiên trước: ${userSession.email}`, 'info')
  }

  createWindow()
  createTray()

  // Validate token in background — if expired, UI gets a 'user: null' event
  validateSessionAsync()

  // Check for updates after 5s delay (non-blocking, low priority)
  setTimeout(() => {
    checkForUpdate().then(result => {
      if (result.hasUpdate && mainWindow && !mainWindow.isDestroyed()) {
        addLog(`Có bản cập nhật mới (${result.behind} commits)`, 'warn')
        mainWindow.webContents.send('update-available', result)
      }
    }).catch(() => {})
  }, 5000)
})

app.on('window-all-closed', () => {
  // Stay in tray
})

app.on('activate', createWindow)

app.on('before-quit', () => {
  isQuitting = true
  stopAgent()
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.removeAllListeners('close')
    mainWindow.close()
  }
})
