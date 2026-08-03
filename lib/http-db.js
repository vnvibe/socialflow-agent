/**
 * http-db.js — VPS API HTTP Proxy Client for SQL Database
 * Routes all DB operations through the VPS API's /agent-db/query endpoint
 *
 * Usage:
 *   const { createClient } = require('./http-db')
 *   const db = createClient(apiUrl, agentSecret)
 */

class HttpQueryBuilder {
  constructor(apiUrl, headers, table) {
    this._apiUrl = apiUrl
    this._headers = headers
    this._table = table
    this._op = 'select'
    this._cols = '*'
    this._filters = []
    this._options = {}
    this._rows = null     // insert / upsert
    this._updates = null  // update
    this._returning = true
  }

  // ── Operations ──
  select(cols, opts) {
    if (this._op !== 'select' || this._rows || this._updates) {
      this._cols = cols || '*'
      return this
    }
    this._cols = cols || '*'
    if (opts?.count === 'exact') this._options.count = 'exact'
    if (opts?.head) this._options.head = true
    return this
  }

  insert(data) {
    this._op = 'insert'
    this._rows = Array.isArray(data) ? data : [data]
    return this
  }

  update(data) {
    this._op = 'update'
    this._updates = data
    return this
  }

  upsert(data, opts) {
    this._op = 'upsert'
    this._rows = Array.isArray(data) ? data : [data]
    if (opts?.onConflict) this._options.onConflict = opts.onConflict
    if (opts?.ignoreDuplicates) this._options.ignoreDuplicates = true
    return this
  }

  delete() { this._op = 'delete'; return this }

  // ── Filters ──
  eq(col, val)   { this._filters.push({ type: 'eq',   column: col, value: val }); return this }
  neq(col, val)  { this._filters.push({ type: 'neq',  column: col, value: val }); return this }
  gt(col, val)   { this._filters.push({ type: 'gt',   column: col, value: val }); return this }
  gte(col, val)  { this._filters.push({ type: 'gte',  column: col, value: val }); return this }
  lt(col, val)   { this._filters.push({ type: 'lt',   column: col, value: val }); return this }
  lte(col, val)  { this._filters.push({ type: 'lte',  column: col, value: val }); return this }
  like(col, val) { this._filters.push({ type: 'like', column: col, value: val }); return this }
  ilike(col, val){ this._filters.push({ type: 'ilike',column: col, value: val }); return this }

  in(col, vals)  { this._filters.push({ type: 'in', column: col, value: vals }); return this }

  is(col, val) {
    if (val === null) this._filters.push({ type: 'is_null', column: col })
    else this._filters.push({ type: 'is', column: col, value: val })
    return this
  }

  not(col, op, val) {
    if (op === 'is' && val === null) {
      this._filters.push({ type: 'is_not_null', column: col })
    } else if (op === 'in') {
      const vals = typeof val === 'string'
        ? val.replace(/[()]/g, '').split(',').map(v => v.trim())
        : val
      this._filters.push({ type: 'not_in', column: col, value: vals })
    } else {
      this._filters.push({ type: 'not', column: col, op, value: val })
    }
    return this
  }

  filter(col, op, val) {
    this._filters.push({ type: 'filter', column: col, op, value: val })
    return this
  }

  or(orString) {
    this._filters.push({ type: 'or', value: orString })
    return this
  }

  // ── Modifiers ──
  order(col, opts) {
    this._options.order = { column: col, ascending: opts?.ascending !== false }
    return this
  }

  limit(n) { this._options.limit = n; return this }

  range(start, end) {
    this._options.offset = start
    this._options.limit = end - start + 1
    return this
  }

  single() { this._options.single = true; return this }
  maybeSingle() { this._options.maybeSingle = true; return this }

  // ── Execution via Promise.then ──
  async then(resolve, reject) {
    try {
      const result = await this._execute()
      resolve(result)
    } catch (err) {
      if (reject) reject(err)
      else resolve({ data: null, error: { message: err.message } })
    }
  }

  async _execute() {
    const axios = require('axios')
    const payload = {
      table: this._table,
      operation: this._op,
      select: this._cols,
      filters: this._filters,
      options: this._options,
      rows: this._rows,
      updates: this._updates,
    }

    const url = `${this._apiUrl}/agent-db/query`
    let attempts = 0
    const maxRetries = 3

    while (attempts <= maxRetries) {
      try {
        const res = await axios.post(url, payload, {
          headers: this._headers,
          timeout: 30000,
        })
        const { data, error, count } = res.data
        if (error) return { data: null, error, count: count ?? null }
        return { data, error: null, count: count ?? null }
      } catch (err) {
        const status = err.response?.status
        if (status === 429 && attempts < maxRetries) {
          attempts++
          const delayMs = Math.pow(2, attempts) * 1000 + Math.floor(Math.random() * 1000)
          console.warn(`[HTTP-DB] ⚠️ Got HTTP 429 Too Many Requests. Retrying in ${delayMs}ms (attempt ${attempts}/${maxRetries})...`)
          await new Promise(r => setTimeout(r, delayMs))
          continue
        }
        const msg = err.response?.data?.error?.message || err.response?.data?.message || err.message
        return { data: null, error: { message: msg, code: status } }
      }
    }
  }
}

function createClient(apiUrl, agentSecret) {
  const axios = require('axios')
  const headers = {
    'Content-Type': 'application/json',
    'X-Agent-Key': agentSecret,
  }

  return {
    from: (table) => new HttpQueryBuilder(apiUrl, headers, table),

    rpc: async (fnName, params) => {
      try {
        const url = `${apiUrl}/agent-db/rpc`
        const res = await axios.post(url, { fn: fnName, params }, { headers, timeout: 15000 })
        return { data: res.data?.data ?? null, error: res.data?.error ?? null }
      } catch (err) {
        const msg = err.response?.data?.error?.message || err.message
        return { data: null, error: { message: msg } }
      }
    },

    channel: () => ({
      on: () => ({ subscribe: (cb) => { if (cb) cb('SUBSCRIBED'); return { unsubscribe: () => {} } } }),
      subscribe: (cb) => { if (cb) cb('SUBSCRIBED'); return { unsubscribe: () => {} } },
    }),
    removeChannel: async () => {},
    auth: {
      getUser: async () => ({ data: { user: null }, error: { message: 'Auth handled via VPS API' } }),
      getSession: async () => ({ data: { session: null }, error: null }),
      signInWithPassword: async () => ({ data: null, error: { message: 'Use VPS API /auth/login instead' } }),
      signOut: async () => ({ error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    },
  }
}

module.exports = { createClient }
