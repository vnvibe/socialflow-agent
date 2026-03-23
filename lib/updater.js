const { execSync } = require('child_process')
const path = require('path')
const fs = require('fs')
const https = require('https')

const REPO_ROOT = path.join(__dirname, '..')
const REMOTE = 'origin'
const GITHUB_REPO = 'nguyentanviet92-pixel/socialflow'
const PACKAGE_PATH = 'socialflow-agent/package.json'

// --- Helpers ---

function isGitRepo() {
  try {
    execSync('git rev-parse --is-inside-work-tree', { cwd: REPO_ROOT, stdio: 'pipe' })
    return true
  } catch { return false }
}

function getLocalVersion() {
  // Git hash if available
  if (isGitRepo()) {
    try {
      return execSync('git rev-parse --short HEAD', { cwd: REPO_ROOT, stdio: 'pipe' }).toString().trim()
    } catch {}
  }
  // Fallback: package.json version
  try {
    return require(path.join(REPO_ROOT, 'package.json')).version
  } catch { return null }
}

function getLocalSemver() {
  try {
    return require(path.join(REPO_ROOT, 'package.json')).version
  } catch { return '0.0.0' }
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'SocialFlow-Agent' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpGet(res.headers.location).then(resolve).catch(reject)
      }
      let data = ''
      res.on('data', c => data += c)
      res.on('end', () => resolve({ status: res.statusCode, data }))
    })
    req.on('error', reject)
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('timeout')) })
  })
}

// --- Check for updates ---

async function checkForUpdate() {
  if (isGitRepo()) return checkForUpdateGit()
  return checkForUpdateHttp()
}

// Git mode: compare commits
async function checkForUpdateGit() {
  try {
    execSync(`git fetch ${REMOTE}`, { cwd: REPO_ROOT, stdio: 'pipe', timeout: 30000 })
    const local = execSync('git rev-parse --short HEAD', { cwd: REPO_ROOT, stdio: 'pipe' }).toString().trim()

    let remoteBranch = null
    for (const b of ['agent', 'master', 'main']) {
      try {
        execSync(`git rev-parse ${REMOTE}/${b}`, { cwd: REPO_ROOT, stdio: 'pipe' })
        remoteBranch = b
        break
      } catch {}
    }
    if (!remoteBranch) return { hasUpdate: false, error: 'No remote branch found' }

    const remote = execSync(`git rev-parse --short ${REMOTE}/${remoteBranch}`, { cwd: REPO_ROOT, stdio: 'pipe' }).toString().trim()
    if (local === remote) return { hasUpdate: false, local, remote }

    const behind = parseInt(execSync(`git rev-list --count HEAD..${REMOTE}/${remoteBranch}`, { cwd: REPO_ROOT, stdio: 'pipe' }).toString().trim())
    const summary = execSync(`git log --oneline HEAD..${REMOTE}/${remoteBranch}`, { cwd: REPO_ROOT, stdio: 'pipe' }).toString().trim()

    return { hasUpdate: behind > 0, local, remote, behind, summary, remoteBranch, method: 'git' }
  } catch (err) {
    return { hasUpdate: false, error: err.message }
  }
}

// HTTP mode (exe): compare package.json version from GitHub
async function checkForUpdateHttp() {
  try {
    const url = `https://raw.githubusercontent.com/${GITHUB_REPO}/main/${PACKAGE_PATH}`
    const res = await httpGet(url)
    if (res.status !== 200) return { hasUpdate: false, error: `HTTP ${res.status}` }

    const remotePkg = JSON.parse(res.data)
    const remoteVer = remotePkg.version
    const localVer = getLocalSemver()

    const hasUpdate = compareSemver(remoteVer, localVer) > 0
    return {
      hasUpdate,
      local: localVer,
      remote: remoteVer,
      method: 'http',
      downloadUrl: `https://github.com/${GITHUB_REPO}/releases`,
    }
  } catch (err) {
    return { hasUpdate: false, error: err.message }
  }
}

// Compare semver: returns >0 if a > b
function compareSemver(a, b) {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return 1
    if ((pa[i] || 0) < (pb[i] || 0)) return -1
  }
  return 0
}

// --- Pull update ---

async function pullUpdate(remoteBranch = 'agent') {
  if (!isGitRepo()) return { success: false, message: 'Exe mode — tai ban moi tu trang tai xuong', method: 'http' }

  try {
    const status = execSync('git status --porcelain', { cwd: REPO_ROOT, stdio: 'pipe' }).toString().trim()
    const hadChanges = status.length > 0
    if (hadChanges) execSync('git stash', { cwd: REPO_ROOT, stdio: 'pipe' })

    execSync(`git pull ${REMOTE} ${remoteBranch} --rebase`, { cwd: REPO_ROOT, stdio: 'pipe', timeout: 60000 })

    if (hadChanges) {
      try { execSync('git stash pop', { cwd: REPO_ROOT, stdio: 'pipe' }) } catch {}
    }

    const newVersion = getLocalVersion()
    return { success: true, message: `Updated to ${newVersion}`, version: newVersion }
  } catch (err) {
    try { execSync('git rebase --abort', { cwd: REPO_ROOT, stdio: 'pipe' }) } catch {}
    try { execSync('git stash pop', { cwd: REPO_ROOT, stdio: 'pipe' }) } catch {}
    return { success: false, message: err.message }
  }
}

module.exports = { isGitRepo, getLocalVersion, getLocalSemver, checkForUpdate, pullUpdate }
