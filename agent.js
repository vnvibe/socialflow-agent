// Load config: config.env > .env > lib/config.js
const path = require('path')
const fs = require('fs')
const envFile = fs.existsSync(path.join(__dirname, 'config.env')) ? 'config.env' : '.env'
require('dotenv').config({ path: path.join(__dirname, envFile) })
const { startPoller, getStopPoller } = require('./jobs/poller')
const { checkFFmpeg } = require('./video/processor')
const os = require('os')

const MAX_CONNECT_RETRIES = 10
const CONNECT_RETRY_DELAY = 5000 // 5s between retries

async function main() {
  console.log('========================================')
  console.log('  SocialFlow Agent starting...')
  console.log('========================================')

  // Check dependencies
  try {
    await checkFFmpeg()
    console.log('[OK] FFmpeg found')
  } catch (err) {
    console.warn('[WARN] FFmpeg not found - video processing disabled')
    console.warn('  Install FFmpeg: https://ffmpeg.org/download.html')
  }

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
  let heartbeatFails = 0
  async function heartbeat() {
    try {
      await supabase.from('agent_heartbeats').upsert({
        agent_id: AGENT_ID,
        last_seen: new Date().toISOString(),
        hostname: os.hostname(),
        platform: os.platform()
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
  const heartbeatInterval = setInterval(heartbeat, 10000)
  console.log('[OK] Heartbeat started')

  // Start job poller (before signal handlers so stopPoller is available)
  startPoller()

  // Cleanup on shutdown - stop poller, close browsers, remove heartbeat
  let isShuttingDown = false
  async function cleanup(signal) {
    if (isShuttingDown) return // prevent double cleanup
    isShuttingDown = true
    console.log(`\n[AGENT] Shutting down (${signal})...`)
    clearInterval(heartbeatInterval)
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
  console.log('[OK] Job poller started (polling every 5s)')
  console.log('Agent running. Waiting for jobs...')
}

main().catch(err => {
  console.error('Agent startup failed:', err)
  process.exit(1)
})
