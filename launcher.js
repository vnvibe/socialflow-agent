#!/usr/bin/env node
require('dotenv').config()
const { spawn } = require('child_process')
const path = require('path')

const FRONTEND_URL = process.env.FRONTEND_URL || 'https://socialflow888.vercel.app'

const COLORS = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  cyan: '\x1b[36m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
}

function log(msg, color = '') { console.log(`${color}${msg}${COLORS.reset}`) }

async function openBrowser(url) {
  const { default: open } = await import('open')
  await open(url)
}

async function main() {
  console.clear()
  log('', '')
  log('  ╔══════════════════════════════════════╗', COLORS.cyan)
  log('  ║                                      ║', COLORS.cyan)
  log('  ║     SocialFlow Agent  v1.0.0         ║', COLORS.cyan)
  log('  ║     Social Media Automation Tool     ║', COLORS.cyan)
  log('  ║                                      ║', COLORS.cyan)
  log('  ╚══════════════════════════════════════╝', COLORS.cyan)
  log('', '')
  log(`  Agent ID:  ${process.env.AGENT_ID || 'default'}`, COLORS.dim)
  log(`  Frontend:  ${FRONTEND_URL}`, COLORS.dim)
  log('', '')

  // Open frontend in browser
  log('  Opening dashboard in browser...', COLORS.yellow)
  try {
    await openBrowser(FRONTEND_URL)
    log(`  Dashboard: ${FRONTEND_URL}`, COLORS.green)
  } catch {
    log(`  Open manually: ${FRONTEND_URL}`, COLORS.yellow)
  }

  log('', '')
  log('  Starting agent...', COLORS.bold)
  log('  ────────────────────────────────────────', COLORS.dim)

  // Start agent as child process
  const agent = spawn('node', [path.join(__dirname, 'agent.js')], {
    cwd: __dirname,
    stdio: 'inherit',
    env: { ...process.env },
  })

  agent.on('exit', (code) => {
    if (code !== 0) {
      log(`\n  Agent exited with code ${code}`, COLORS.red)
    }
    process.exit(code)
  })

  // Handle Ctrl+C gracefully
  process.on('SIGINT', () => {
    log('\n  Shutting down agent...', COLORS.yellow)
    agent.kill('SIGINT')
    setTimeout(() => process.exit(0), 2000)
  })
}

main().catch(e => {
  log(`  Error: ${e.message}`, COLORS.red)
  process.exit(1)
})
