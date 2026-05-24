/**
 * http-supabase.js — Drop-in replacement for @supabase/supabase-js
 * Routes all DB operations through the VPS API's /agent-db/query endpoint
 * instead of connecting to Supabase cloud directly.
 *
 * Usage:
 *   const { createClient } = require('./http-supabase')
 *   const supabase = createClient(apiUrl, agentSecret)
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
      // .select() after insert/update = RETURNING cols
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
    // Store as-is; server-side handles OR parsing if needed
    this._filters.push({ type: 'or', value: orString })
    return this
  }

  // ── Modifiers ──
  order(col, opts) {
    this._options.order = { column: col, ascending: opts?.ascending !== false }
    return this
  }
  limit(n)   { this._options.limit = n; return this }
  offset(n)  { this._options.offset = n; return this }
  range(s, e){ this._options.offset = s; this._options.limit = e - s + 1; return this }
  single()       { this._options.single = true; this._options.limit = 1; return this }
  maybeSingle()  { this._options.maybeSingle = true; this._options.limit = 1; return this }

  // ── Execute (thenable) ──
  then(resolve, reject) {
    this._send().then(resolve, reject)
  }

  async _send() {
    const body = {
      op: this._op,
      table: this._table,
      cols: this._cols,
      rows: this._rows,
      updates: this._updates,
      filters: this._filters,
      options: this._options,
      returning: this._returning,
    }
    try {
      const res = await fetch(`${this._apiUrl}/agent-db/query`, {
        method: 'POST',
        headers: { ...this._headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const text = await res.text().catch(() => res.statusText)
        return { data: null, error: { message: `HTTP ${res.status}: ${text}` } }
      }
      return await res.json()
    } catch (err) {
      return { data: null, error: { message: err.message } }
    }
  }
}

function createClient(apiUrl, agentSecret) {
  const headers = { 'X-Agent-Key': agentSecret }

  return {
    from: (table) => new HttpQueryBuilder(apiUrl, headers, table),

    rpc: async (fnName, params) => {
      try {
        const res = await fetch(`${apiUrl}/agent-db/query`, {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ op: 'rpc', rpc: fnName, options: { params } }),
        })
        if (!res.ok) return { data: null, error: { message: `HTTP ${res.status}` } }
        return await res.json()
      } catch (err) {
        return { data: null, error: { message: err.message } }
      }
    },

    // Realtime stubs — no actual subscription, poller handles polling
    channel: () => ({
      on: function() { return this },
      subscribe: (cb) => { if (cb) cb('SUBSCRIBED'); return { unsubscribe: () => {} } },
    }),
    removeChannel: async () => {},

    auth: {
      getUser: async () => ({ data: { user: null }, error: null }),
      getSession: async () => ({ data: { session: null }, error: null }),
      signInWithPassword: async () => ({ data: null, error: { message: 'Use API /auth/login' } }),
      signOut: async () => ({ error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    },
  }
}

module.exports = { createClient }
