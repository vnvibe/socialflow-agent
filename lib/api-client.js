// HTTP client for SocialFlow API — replaces direct DB queries for job lifecycle
// Uses native fetch (Node 18+)
const AGENT_ID = require('os').hostname() + '-' + process.pid

class ApiClient {
  constructor() {
    this.baseUrl = process.env.API_URL || 'https://103-142-24-60.sslip.io'
    this.agentSecret = process.env.AGENT_SECRET || ''
    this.agentId = process.env.AGENT_ID || AGENT_ID
    this.userId = process.env.AGENT_USER_ID || null
    this.timeout = 10000 // 10s default

    if (!this.agentSecret) {
      console.warn('[API-CLIENT] AGENT_SECRET not set — agent-jobs API calls will fail')
    }
  }

  async _fetch(method, path, body = null, opts = {}) {
    const url = `${this.baseUrl}/agent-jobs${path}`
    const headers = {
      'X-Agent-Key': this.agentSecret,
      'X-Agent-Id': this.agentId,
      'Content-Type': 'application/json',
    }
    if (this.userId) headers['X-Agent-User-Id'] = this.userId

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), opts.timeout || this.timeout)

    try {
      const res = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      })

      const json = await res.json().catch(() => null)

      if (!res.ok) {
        const msg = json?.error || `HTTP ${res.status}`
        const err = new Error(msg)
        err.status = res.status
        throw err
      }

      return json
    } finally {
      clearTimeout(timer)
    }
  }

  // ─── Job lifecycle ─────────────────────────────────────

  async getPendingJobs(slots = 10) {
    const params = new URLSearchParams({ slots: String(slots) })
    if (this.userId) params.set('user_id', this.userId)
    return this._fetch('GET', `/pending?${params}`)
  }

  async claimJob(jobId) {
    return this._fetch('PATCH', `/${jobId}/claim`, { agent_id: this.agentId })
  }

  async updateJobStatus(jobId, status, extra = {}) {
    return this._fetch('PATCH', `/${jobId}/status`, { status, ...extra })
  }

  async completeJob(jobId, result = null) {
    return this._fetch('PATCH', `/${jobId}/complete`, { result })
  }

  async failJob(jobId, errorMessage, attempt) {
    return this._fetch('PATCH', `/${jobId}/fail`, { error_message: errorMessage, attempt })
  }

  // ─── Supporting operations ─────────────────────────────

  async recoverStaleJobs() {
    return this._fetch('POST', '/recover-stale')
  }

  async cancelInactiveJob(jobId, accountId) {
    return this._fetch('POST', '/cancel-inactive', { job_id: jobId, account_id: accountId })
  }

  async recordJobFailure(data) {
    return this._fetch('POST', '/failures', data)
  }

  async getAccountStatus(accountId) {
    return this._fetch('GET', `/account-status/${accountId}`)
  }

  async getExcludedUsers() {
    return this._fetch('GET', `/excluded-users?agent_id=${encodeURIComponent(this.agentId)}`)
  }

  async sendHeartbeat(stats = null) {
    const os = require('os')
    return this._fetch('POST', '/heartbeat', {
      agent_id: this.agentId,
      hostname: os.hostname(),
      platform: os.platform(),
      user_id: this.userId,
      stats,
    })
  }
}

// Singleton
let _instance = null
function getApiClient() {
  if (!_instance) _instance = new ApiClient()
  return _instance
}

module.exports = { getApiClient, ApiClient }
