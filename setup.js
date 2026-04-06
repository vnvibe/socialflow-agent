#!/usr/bin/env node
const { execSync, exec } = require('child_process')
const fs = require('fs')
const path = require('path')
const readline = require('readline')

const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
const ask = (q) => new Promise(r => rl.question(q, r))

const COLORS = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  bold: '\x1b[1m',
}

function log(msg, color = '') { console.log(`${color}${msg}${COLORS.reset}`) }
function ok(msg) { log(`  [OK] ${msg}`, COLORS.green) }
function warn(msg) { log(`  [!] ${msg}`, COLORS.yellow) }
function err(msg) { log(`  [X] ${msg}`, COLORS.red) }

function cmdExists(cmd) {
  try {
    execSync(`where ${cmd}`, { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

function getVersion(cmd) {
  try {
    return execSync(`${cmd} --version`, { stdio: 'pipe' }).toString().trim().split('\n')[0]
  } catch { return null }
}

async function main() {
  console.log('')
  log('========================================', COLORS.cyan)
  log('   SocialFlow Agent - Setup Wizard', COLORS.bold)
  log('========================================', COLORS.cyan)
  console.log('')

  // Step 1: Check Node.js
  log('1. Checking Node.js...', COLORS.bold)
  const nodeVer = process.version
  const major = parseInt(nodeVer.slice(1))
  if (major >= 18) {
    ok(`Node.js ${nodeVer}`)
  } else {
    err(`Node.js ${nodeVer} - need v18+`)
    log('   Download: https://nodejs.org/')
    process.exit(1)
  }

  // Step 2: Install npm dependencies
  console.log('')
  log('2. Installing dependencies...', COLORS.bold)
  try {
    execSync('npm install', { cwd: __dirname, stdio: 'inherit' })
    ok('Dependencies installed')
  } catch {
    err('npm install failed')
    process.exit(1)
  }

  // Step 3: Install Playwright browser
  console.log('')
  log('3. Installing browser...', COLORS.bold)
  try {
    execSync('npx playwright install chromium', { cwd: __dirname, stdio: 'inherit' })
    ok('Chromium browser installed')
  } catch {
    warn('Playwright install failed - browser automation may not work')
  }

  // Step 4: Check .env
  console.log('')
  log('4. Checking configuration...', COLORS.bold)
  const envPath = path.join(__dirname, '.env')

  if (fs.existsSync(envPath)) {
    // .env already exists (pre-configured by admin download)
    ok('.env found — configuration ready')
    await finalize()
    return
  }

  // No .env — manual setup (shouldn't happen for downloaded agent)
  warn('.env not found — manual configuration required')
  console.log('')

  const supabaseUrl = await ask('   SUPABASE_URL: ')
  const supabaseKey = await ask('   SUPABASE_ANON_KEY: ')

  const envContent = `# Supabase
SUPABASE_URL=${supabaseUrl.trim()}
SUPABASE_ANON_KEY=${supabaseKey.trim()}

# Frontend
FRONTEND_URL=https://socialflow888.vercel.app

# Agent
AGENT_ID=agent-${require('os').hostname()}
`

  fs.writeFileSync(envPath, envContent)
  ok('.env created')

  await finalize()
}

async function finalize() {
  // Step 5: Create desktop shortcut
  console.log('')
  log('5. Create desktop shortcut?', COLORS.bold)
  const shortcut = await ask('   Create "SocialFlow Agent" shortcut on Desktop? (y/n): ')

  if (shortcut.toLowerCase() === 'y') {
    createDesktopShortcut()
  }

  // Step 6: Test connection
  console.log('')
  log('6. Testing connection...', COLORS.bold)
  try {
    require('dotenv').config({ path: path.join(__dirname, '.env') })
    const { createClient } = require('@supabase/supabase-js')
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)
    const { error } = await supabase.from('jobs').select('id').limit(1)
    if (error) throw error
    ok('Supabase connection successful!')
  } catch (e) {
    err(`Connection failed: ${e.message}`)
    warn('Check your SUPABASE_URL and SUPABASE_ANON_KEY in .env')
  }

  console.log('')
  log('========================================', COLORS.green)
  log('   Setup complete!', COLORS.bold)
  log('========================================', COLORS.green)
  console.log('')
  log('   Start agent:  npm start', COLORS.cyan)
  log('   Or launch:    npm run launch', COLORS.cyan)
  log('   Or double-click the desktop shortcut', COLORS.cyan)
  console.log('')

  rl.close()
}

function createDesktopShortcut() {
  const isWindows = process.platform === 'win32'

  if (isWindows) {
    const desktop = path.join(require('os').homedir(), 'Desktop')
    const agentDir = __dirname.replace(/\//g, '\\')

    // Create a .bat launcher
    const batPath = path.join(agentDir, 'SocialFlow.bat')
    const batContent = `@echo off
title SocialFlow Agent
cd /d "${agentDir}"
node launcher.js
pause
`
    fs.writeFileSync(batPath, batContent)

    // Create VBS to make a shortcut
    const vbsPath = path.join(agentDir, '_create_shortcut.vbs')
    const shortcutPath = path.join(desktop, 'SocialFlow Agent.lnk')
    const vbs = `Set WshShell = WScript.CreateObject("WScript.Shell")
Set Shortcut = WshShell.CreateShortcut("${shortcutPath}")
Shortcut.TargetPath = "${batPath}"
Shortcut.WorkingDirectory = "${agentDir}"
Shortcut.Description = "SocialFlow Agent - Social Media Automation"
Shortcut.Save
WScript.Echo "Shortcut created!"
`
    fs.writeFileSync(vbsPath, vbs)

    try {
      execSync(`cscript //nologo "${vbsPath}"`, { stdio: 'pipe' })
      fs.unlinkSync(vbsPath) // cleanup vbs
      ok('Desktop shortcut created!')
    } catch {
      warn('Could not create shortcut automatically')
      ok(`Batch file created: ${batPath}`)
      log('   You can create a shortcut to this file manually', COLORS.cyan)
    }
  } else {
    // Linux/Mac - create shell script
    const shPath = path.join(__dirname, 'socialflow.sh')
    const shContent = `#!/bin/bash
cd "$(dirname "$0")"
node launcher.js
`
    fs.writeFileSync(shPath, shContent, { mode: 0o755 })
    ok(`Shell script created: ${shPath}`)
  }
}

main().catch(e => {
  err(e.message)
  rl.close()
  process.exit(1)
})
