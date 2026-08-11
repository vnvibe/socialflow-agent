// HTTP client for SocialFlow API — replaces direct DB queries for job lifecycle
// Uses native fetch (Node 18+)
// Cùng nguồn với heartbeat/poller — xem lib/agent-id.js. Trước đây nơi này
// dùng `hostname-pid` rồi lại ưu tiên _cfg.AGENT_ID ("audit-agent") nên mọi
// máy nhận job dưới CÙNG một tên, phá khoá tài khoản phía server.
const { getAgentId } = require('./agent-id')

let _cfg = {}
try { _cfg = require('./config') } catch {}

class ApiClient {
  constructor() {
    this.timeout = 10000 // 10s default
  }

  get baseUrl() {
    return process.env.API_URL || _cfg.API_URL || 'https://103-142-24-60.sslip.io'
  }

  get agentSecret() {
    return process.env.AGENT_SECRET || process.env.AGENT_SECRET_KEY || _cfg.AGENT_SECRET_KEY || ''
  }

  get agentId() {
    // KHÔNG lấy _cfg.AGENT_ID nữa: giá trị đó là hằng số nướng sẵn lúc build
    // ("audit-agent"), giống hệt nhau trên mọi máy.
    return getAgentId()
  }

  get userId() {
    return process.env.AGENT_USER_ID || null
  }

  async _fetch(method, path, body = null, opts = {}) {
    if (!this.agentSecret) {
      console.warn(`[API-CLIENT] Warning: AGENT_SECRET is not configured! Call to ${path} may fail due to authentication.`)
    }
    const url = `${this.baseUrl}/agent-jobs${path}`
    const headers = {
      'X-Agent-Key': this.agentSecret,
      'X-Agent-Id': this.agentId,
    }
    if (this.userId) headers['X-Agent-User-Id'] = this.userId

    // Only set Content-Type when there's an actual body — Fastify rejects
    // requests with Content-Type: application/json but empty body
    // (FST_ERR_CTP_EMPTY_JSON_BODY → 400)
    const hasBody = body !== null && body !== undefined
    if (hasBody) headers['Content-Type'] = 'application/json'

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), opts.timeout || this.timeout)

    try {
      const res = await fetch(url, {
        method,
        headers,
        body: hasBody ? JSON.stringify(body) : undefined,
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
    } catch (err) {
      if (err.name !== 'AbortError' && !err.status) {
        const msg = err.cause ? `${err.message} (cause: ${err.cause.message || err.cause})` : err.message
        const newErr = new Error(msg)
        newErr.cause = err.cause
        throw newErr
      }
      throw err
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
