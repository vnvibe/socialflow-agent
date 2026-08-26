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

  // RANH GIỚI TENANT — KHÔNG ĐƯỢC NỚI.
  //
  // Agent chỉ nhặt job của ĐÚNG user đang đăng nhập trên máy này. Đây không
  // phải giới hạn kỹ thuật thừa: chạy job của user khác nghĩa là tải
  // cookie_string Facebook của họ về máy này và mở trong browser ở đây —
  // là xâm phạm tài khoản khách hàng, kể cả khi cùng một tổ chức.
  //
  // Từng có lần đổi thành exclude_user_ids (nhặt job mọi user trừ ai đã ghim
  // executor khác) để "cứu" job đang tồn của user khác. SAI: user đó có agent
  // riêng của họ. Job của họ không chạy là BUG Ở AGENT CỦA HỌ, phải sửa chỗ
  // đó — không phải để máy khác nhảy vào chạy hộ.
  async getPendingJobs(slots = 10) {
    const params = new URLSearchParams({ slots: String(slots) })
    // MÁY FARM CHUNG (user chốt 23/08): ALLOWED_USER_IDS trong .env = danh sách
    // user mà máy này được phép chạy nick. Khi set, agent nhận job của TẤT CẢ
    // user trong danh sách bất kể ai đang đăng nhập Electron — fix ca thật:
    // login user A (7be4f007) làm nick của user B (274868cf — Lorena) đói job
    // ban ngày, chỉ chạy đêm khi không có session. Không set → giữ ranh giới
    // tenant cũ (chỉ user đăng nhập).
    const allowed = (process.env.ALLOWED_USER_IDS || '').trim()
    if (allowed) params.set('allowed_user_ids', allowed)
    else if (this.userId) params.set('user_id', this.userId)
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
    // MÁY FARM CHUNG (23-24/08): heartbeat phải đại diện cho MỌI user trong
    // ALLOWED_USER_IDS — feed-scheduler VPS chỉ xếp lịch cho user có heartbeat
    // <3 phút. Trước đây chỉ gửi user đăng nhập (7be4f007) → user kia (274868cf,
    // Lorena) bị coi offline → KHÔNG được xếp feed job (đo thật 24/08: 0 lịch).
    const allowedIds = (process.env.ALLOWED_USER_IDS || '').split(',').map(s => s.trim()).filter(Boolean)
    return this._fetch('POST', '/heartbeat', {
      agent_id: this.agentId,
      hostname: os.hostname(),
      platform: os.platform(),
      user_id: this.userId,
      ...(allowedIds.length ? { user_ids: allowedIds } : {}),
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
