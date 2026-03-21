const { firefox } = require('playwright')
const path = require('path')
const os = require('os')
const fs = require('fs')

const CAMOUFOX_PATHS = {
  linux: path.join(os.homedir(), '.socialflow', 'browsers', 'camoufox', 'firefox'),
  darwin: path.join(os.homedir(), '.socialflow', 'browsers', 'camoufox', 'Camoufox.app/Contents/MacOS/firefox'),
  win32: path.join(os.homedir(), '.socialflow', 'browsers', 'camoufox', 'firefox.exe')
}

function getCamoufoxExecutable() {
  const execPath = CAMOUFOX_PATHS[process.platform] || CAMOUFOX_PATHS.linux
  if (!fs.existsSync(execPath)) {
    throw new Error(`Camoufox not found at: ${execPath}. Download from: https://github.com/nicegamer7/camoufox`)
  }
  return execPath
}

async function launchCamoufox(options = {}) {
  const execPath = getCamoufoxExecutable()

  const browser = await firefox.launch({
    executablePath: execPath,
    headless: options.headless || false,
    args: options.args || [],
    ...(options.proxy && { proxy: options.proxy })
  })

  return browser
}

function isCamoufoxInstalled() {
  const execPath = CAMOUFOX_PATHS[process.platform] || CAMOUFOX_PATHS.linux
  return fs.existsSync(execPath)
}

module.exports = { launchCamoufox, getCamoufoxExecutable, isCamoufoxInstalled }
