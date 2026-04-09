// Load config: config.env > .env > lib/config.js
const path = require('path')
const fs = require('fs')
const { execSync } = require('child_process')
const envFile = fs.existsSync(path.join(__dirname, 'config.env')) ? 'config.env' : '.env'
require('dotenv').config({ path: path.join(__dirname, envFile) })
const { startPoller, getStopPoller, getPool } = require('./jobs/poller')
const os = require('os')

const MAX_CONNECT_RETRIES = 10
const CONNECT_RETRY_DELAY = 5000 // 5s between retries

/**
 * Kill zombie Chromium processes từ session trước (chỉ kill socialflow profiles)
 */
function killZombieChromium() {
  try {
    const profileDir = path.join(os.homedir(), '.socialflow', 'profiles')
    if (process.platform === 'win32') {
      // Use PowerShell (wmic removed in Win11) to find Chromium with our profile dir
      const escaped = profileDir.replace(/\\/g, '\\\\')
      const result = execSync(
        `powershell -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${escaped}*' } | Select-Object -ExpandProperty ProcessId"`,
        { encoding: 'utf8', timeout: 8000 }
      ).trim()
      const pids = result.split(/\r?\n/).map(s => s.trim()).filter(s => /^\d+$/.test(s))
      for (const pid of pids) {
        try { execSync(`taskkill /F /PID ${pid}`, { timeout: 3000, stdio: 'ignore' }) } catch {}
      }
      if (pids.length) console.log(`[CLEANUP] Killed ${pids.length} zombie Chromium process(es)`)
    } else {
      execSync(`pkill -f "${profileDir}" || true`, { timeout: 5000 })
    }
  } catch {}
}

async function main() {
  // Kill leftover Chromium from previous crashed session
  killZombieChromium()

  console.log('========================================')
  console.log('  SocialFlow Agent starting...')
  console.log('========================================')

  // Check Supabase connection with retry
  const { supabase } = require('./lib/supabase')
  let connected = false
  for (let i = 1; i <= MAX_CONNECT_RETRIES; i++) {
    const { error } = await supabase.from('jobs').select('id').limit(1)
    if (!error) {
      connected = true
      break
    }
    console.warn(`[WARN] Supabase connect failed (attempt ${i}/${MAX_CONNECT_RETRIES}): ${error.message}`)
    if (i < MAX_CONNECT_RETRIES) {
      console.log(`[AGENT] Retrying in ${CONNECT_RETRY_DELAY / 1000}s...`)
      await new Promise(r => setTimeout(r, CONNECT_RETRY_DELAY))
    }
  }
  if (!connected) {
    console.error('[ERROR] Cannot connect to Supabase after all retries. Exiting.')
    process.exit(1)
  }
  console.log('[OK] Supabase connected')

  // Start heartbeat
  const { config } = require('./lib/supabase')
  const AGENT_ID = process.env.AGENT_ID || config.AGENT_ID || `${os.hostname()}-${process.pid}`
  const pkg = require('./package.json')
  let heartbeatFails = 0
  async function heartbeat() {
    try {
      const pool = getPool()
      const memUsage = process.memoryUsage()
      await supabase.from('agent_heartbeats').upsert({
        agent_id: AGENT_ID,
        machine_name: os.hostname(),
        owner_id: process.env.AGENT_USER_ID || null,
        version: pkg.version,
        status: 'online',
        platform: os.platform(),
        cpu_usage: os.loadavg()[0],
        mem_usage: Math.round((memUsage.heapUsed / memUsage.heapTotal) * 100),
        running_jobs: pool.size,
        running_accounts: [...pool.interactionNicks, ...pool.utilityNicks],
        jobs_today: pool.jobsToday,
        jobs_failed: pool.jobsFailed,
        last_seen_at: new Date().toISOString(),
        // Keep legacy fields for backward compat
        last_seen: new Date().toISOString(),
        hostname: os.hostname(),
        ...(process.env.AGENT_USER_ID && { user_id: process.env.AGENT_USER_ID }),
      }, { onConflict: 'agent_id' })
      if (heartbeatFails > 0) {
        console.log(`[HEARTBEAT] Reconnected after ${heartbeatFails} failures`)
        heartbeatFails = 0
      }
    } catch (err) {
      heartbeatFails++
      if (heartbeatFails === 1 || heartbeatFails % 6 === 0) {
        console.warn(`[HEARTBEAT] Failed (${heartbeatFails}x): ${err.message}`)
      }
    }
  }
  heartbeat()
  const heartbeatInterval = setInterval(heartbeat, 30000) // 30s instead of 10s
  console.log('[OK] Heartbeat started')

  // Phase 12: keep Railway API awake while agent is running.
  // Ping /health every 3 minutes — Railway free-tier sleeps after ~15min idle,
  // so this prevents cold starts during active agent sessions. Fire-and-forget.
  const API_URL = process.env.API_URL || process.env.API_BASE_URL
  let keepAliveInterval = null
  if (API_URL) {
    const https = require('https')
    const http = require('http')
    const { URL } = require('url')
    const pingHealth = () => {
      try {
        const u = new URL(`${API_URL}/health`)
        const lib = u.protocol === 'https:' ? https : http
        const req = lib.request({
          hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
          path: u.pathname, method: 'GET', timeout: 10000,
        }, (res) => { res.resume() /* drain */ })
        req.on('error', () => {}) // silent
        req.on('timeout', () => req.destroy())
        req.end()
      } catch {}
    }
    pingHealth() // fire immediately
    keepAliveInterval = setInterval(pingHealth, 3 * 60 * 1000) // every 3 min
    console.log(`[OK] Keep-alive ping started → ${API_URL}/health every 3min`)
  }

  // Start job poller (before signal handlers so stopPoller is available)
  startPoller()

  // Cleanup on shutdown - stop poller, close browsers, remove heartbeat
  let isShuttingDown = false
  async function cleanup(signal) {
    if (isShuttingDown) return // prevent double cleanup
    isShuttingDown = true
    console.log(`\n[AGENT] Shutting down (${signal})...`)
    clearInterval(heartbeatInterval)
    if (keepAliveInterval) clearInterval(keepAliveInterval)
    // Stop poller & close browser sessions
    try {
      await getStopPoller()()
    } catch (err) {
      console.warn(`[WARN] Poller stop error: ${err.message}`)
    }
    // Try to delete heartbeat with timeout (max 3s)
    try {
      await Promise.race([
        supabase.from('agent_heartbeats').delete().eq('agent_id', AGENT_ID),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000))
      ])
      console.log('[OK] Heartbeat removed')
    } catch (err) {
      console.warn(`[WARN] Could not remove heartbeat: ${err.message} (will expire in 15s)`)
    }
    process.exit(0)
  }
  process.on('SIGINT', () => cleanup('SIGINT'))
  process.on('SIGTERM', () => cleanup('SIGTERM'))
  process.on('SIGHUP', () => cleanup('SIGHUP'))
  // Windows: Ctrl+C in terminal sends this
  if (process.platform === 'win32') {
    process.on('beforeExit', () => cleanup('beforeExit'))
    process.on('uncaughtException', async (err) => {
      console.error('[AGENT] Uncaught exception:', err.message)
      await cleanup('uncaughtException')
    })
  }
  console.log('[OK] Job poller started (polling every 5s)')
  console.log('Agent running. Waiting for jobs...')
}

main().catch(err => {
  console.error('Agent startup failed:', err)
  process.exit(1)
})
