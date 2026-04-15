/**
 * pg-supabase.js — Drop-in replacement for @supabase/supabase-js
 * Uses native pg Pool instead of Supabase REST API.
 * Implements the subset of supabase-js API actually used in codebase.
 *
 * Usage:
 *   const { createClient } = require('./pg-supabase')
 *   const supabase = createClient(process.env.DATABASE_URL)
 *   // Same API: supabase.from('table').select('*').eq('id', 1)
 */

const { Pool } = require('pg')

// FK cache: loaded once on first query
let _fkMap = null
async function loadFKMap(pool) {
  if (_fkMap) return _fkMap
  try {
    const { rows } = await pool.query(`
      SELECT tc.table_name, kcu.column_name, ccu.table_name as ref_table, ccu.column_name as ref_col
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
      JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
      WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'
    `)
    _fkMap = new Map()
    for (const r of rows) {
      // Key: "parent_table:child_table" → { fkCol, refCol, direction }
      // Direction 1: table_name has FK column pointing to ref_table
      // e.g., accounts.proxy_id → proxies.id
      const key1 = `${r.table_name}:${r.ref_table}`
      if (!_fkMap.has(key1)) _fkMap.set(key1, [])
      _fkMap.get(key1).push({ from: `${r.table_name}.${r.column_name}`, to: `${r.ref_table}.${r.ref_col}` })

      const key2 = `${r.ref_table}:${r.table_name}`
      if (!_fkMap.has(key2)) _fkMap.set(key2, [])
      _fkMap.get(key2).push({ from: `${r.table_name}.${r.column_name}`, to: `${r.ref_table}.${r.ref_col}` })
    }
    console.log(`[PG-SUPABASE] FK map loaded: ${rows.length} relationships`)
  } catch (err) {
    console.warn(`[PG-SUPABASE] FK map load failed: ${err.message} — using heuristic`)
    _fkMap = new Map()
  }
  return _fkMap
}

function createClient(databaseUrl) {
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  })

  pool.on('error', (err) => {
    console.error('[PG-POOL] Unexpected error on idle client:', err.message)
  })

  // Pre-load FK map
  loadFKMap(pool).catch(() => {})

  return {
    from: (table) => new QueryBuilder(pool, table),
    rpc: (fnName, params) => rpcCall(pool, fnName, params),
    // Stubs for unused features
    channel: () => ({
      on: () => ({ subscribe: (cb) => { if (cb) cb('SUBSCRIBED'); return { unsubscribe: () => {} } } }),
      subscribe: (cb) => { if (cb) cb('SUBSCRIBED'); return { unsubscribe: () => {} } },
    }),
    removeChannel: async () => {},
    auth: {
      getUser: async () => ({ data: { user: null }, error: { message: 'Auth not available in pg-supabase' } }),
      getSession: async () => ({ data: { session: null }, error: null }),
      signInWithPassword: async () => ({ data: null, error: { message: 'Use API /auth/login instead' } }),
      signOut: async () => ({ error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    },
    _pool: pool, // Expose for direct SQL when needed
  }
}

class QueryBuilder {
  constructor(pool, table) {
    this._pool = pool
    this._table = table
    this._operation = 'select'
    this._selectCols = '*'
    this._wheres = []
    this._orders = []
    this._limitVal = null
    this._offsetVal = null
    this._rangeStart = null
    this._rangeEnd = null
    this._returnSingle = false
    this._returnMaybeSingle = false
    this._data = null
    this._upsertOptions = null
    this._returnSelect = null // .select() after insert/update
    this._countMode = null // 'exact' for count queries
    this._headOnly = false // true = return count only, no rows
  }

  // ── Operations ──
  select(cols, options) {
    if (this._operation !== 'select' || this._data) {
      // .select() after .insert()/.update()/.upsert() = RETURNING clause
      this._returnSelect = cols || '*'
      return this
    }
    this._selectCols = cols || '*'
    if (options?.count === 'exact') this._countMode = 'exact'
    if (options?.head) this._headOnly = true
    return this
  }

  insert(data) {
    this._operation = 'insert'
    this._data = Array.isArray(data) ? data : [data]
    return this
  }

  update(data) {
    this._operation = 'update'
    this._data = data
    return this
  }

  upsert(data, options) {
    this._operation = 'upsert'
    this._data = Array.isArray(data) ? data : [data]
    this._upsertOptions = options || {}
    return this
  }

  delete() {
    this._operation = 'delete'
    return this
  }

  // ── Filters ──
  eq(col, val) { this._wheres.push({ col, op: '=', val }); return this }
  neq(col, val) { this._wheres.push({ col, op: '!=', val }); return this }
  gt(col, val) { this._wheres.push({ col, op: '>', val }); return this }
  gte(col, val) { this._wheres.push({ col, op: '>=', val }); return this }
  lt(col, val) { this._wheres.push({ col, op: '<', val }); return this }
  lte(col, val) { this._wheres.push({ col, op: '<=', val }); return this }

  in(col, vals) {
    this._wheres.push({ col, op: 'IN', val: vals })
    return this
  }

  is(col, val) {
    this._wheres.push({ col, op: val === null ? 'IS NULL' : `IS ${val}`, val: null, raw: true })
    return this
  }

  not(col, operator, val) {
    if (operator === 'is' && val === null) {
      this._wheres.push({ col, op: 'IS NOT NULL', val: null, raw: true })
    } else if (operator === 'in') {
      // .not('col', 'in', '(val1,val2)') — parse the parenthesized list
      const vals = val.replace(/[()]/g, '').split(',').map(v => v.trim())
      this._wheres.push({ col, op: 'NOT IN', val: vals })
    } else {
      this._wheres.push({ col, op: `NOT ${operator}`, val })
    }
    return this
  }

  like(col, pattern) { this._wheres.push({ col, op: 'LIKE', val: pattern }); return this }
  ilike(col, pattern) { this._wheres.push({ col, op: 'ILIKE', val: pattern }); return this }

  filter(col, operator, val) {
    // Handle JSONB arrow operator: 'payload->>key'
    if (col.includes('->>')) {
      this._wheres.push({ col, op: operator === 'eq' ? '=' : operator, val, jsonb: true })
    } else {
      const opMap = { eq: '=', neq: '!=', gt: '>', gte: '>=', lt: '<', lte: '<=' }
      this._wheres.push({ col, op: opMap[operator] || operator, val })
    }
    return this
  }

  or(orString) {
    // Parse PostgREST OR format: 'col1.eq.val1,col2.eq.val2'
    // Also handles: 'status.eq.running,status.eq.active,status.is.null'
    // And JSONB: 'payload->>account_id.eq.uuid1,payload->>account_id.eq.uuid2'
    const conditions = []
    const parts = orString.split(',')
    for (const part of parts) {
      // Split on LAST occurrence pattern: col.op.val — but col may contain ">>" or "->"
      // Use regex: everything up to .(eq|neq|gt|gte|lt|lte|is|like|ilike). then value
      const m = part.trim().match(/^(.+?)\.(eq|neq|gt|gte|lt|lte|is|like|ilike)\.?(.*)$/)
      if (!m) continue
      const [, col, op, val] = m
      if (op === 'eq') conditions.push({ col, op: '=', val })
      else if (op === 'neq') conditions.push({ col, op: '!=', val })
      else if (op === 'is' && val === 'null') conditions.push({ col, op: 'IS NULL', val: null, raw: true })
      else if (op === 'gt') conditions.push({ col, op: '>', val })
      else if (op === 'gte') conditions.push({ col, op: '>=', val })
      else if (op === 'lt') conditions.push({ col, op: '<', val })
      else if (op === 'lte') conditions.push({ col, op: '<=', val })
      else if (op === 'like') conditions.push({ col, op: 'LIKE', val })
      else if (op === 'ilike') conditions.push({ col, op: 'ILIKE', val })
    }
    this._wheres.push({ or: conditions })
    return this
  }

  // ── Modifiers ──
  order(col, opts) {
    const dir = opts?.ascending === false ? 'DESC' : 'ASC'
    this._orders.push(`${col} ${dir}`)
    return this
  }

  limit(n) { this._limitVal = n; return this }

  range(start, end) {
    this._offsetVal = start
    this._limitVal = end - start + 1
    return this
  }

  single() { this._returnSingle = true; this._limitVal = 1; return this }
  maybeSingle() { this._returnMaybeSingle = true; this._limitVal = 1; return this }

  // ── Execute ──
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
    // Ensure FK map loaded before first query with joins
    if (!_fkMap) await loadFKMap(this._pool)

    const params = []
    let paramIdx = 1

    const addParam = (val) => {
      params.push(val)
      return `$${paramIdx++}`
    }

    // Prepare value for pg: arrays pass as-is (pg handles natively), objects stringify for jsonb
    const pgVal = (val) => {
      if (val === null || val === undefined) return val
      if (Array.isArray(val)) return val // pg driver handles JS arrays → PostgreSQL arrays
      if (typeof val === 'object') return JSON.stringify(val) // plain objects → jsonb string
      return val
    }

    // Fix JSONB column refs: payload->>account_id → payload->>'account_id'
    const fixCol = (col) => {
      if (col.includes('->>')) {
        const [table, key] = col.split('->>')
        return `${table}->>'${key}'`
      }
      if (col.includes('->')) {
        const [table, key] = col.split('->')
        return `${table}->'${key}'`
      }
      return col
    }

    const buildWhere = () => {
      if (this._wheres.length === 0) return ''
      const conditions = this._wheres.map(w => {
        if (w.or) {
          const orConds = w.or.map(c => {
            if (c.raw) return `${fixCol(c.col)} ${c.op}`
            return `${fixCol(c.col)} ${c.op} ${addParam(c.val)}`
          })
          return `(${orConds.join(' OR ')})`
        }
        if (w.raw) return `${fixCol(w.col)} ${w.op}`
        if (w.op === 'IN' || w.op === 'NOT IN') {
          if (!Array.isArray(w.val) || w.val.length === 0) {
            return w.op === 'IN' ? 'FALSE' : 'TRUE'
          }
          const placeholders = w.val.map(v => addParam(v))
          return `${fixCol(w.col)} ${w.op} (${placeholders.join(', ')})`
        }
        if (w.jsonb) return `${fixCol(w.col)} ${w.op} ${addParam(w.val)}`
        return `${fixCol(w.col)} ${w.op} ${addParam(pgVal(w.val))}`
      })
      return ' WHERE ' + conditions.join(' AND ')
    }

    try {
      let sql, result

      switch (this._operation) {
        case 'select': {
          // Handle count-only queries: .select('id', { count: 'exact', head: true })
          if (this._countMode === 'exact' && this._headOnly) {
            sql = `SELECT COUNT(*) as count FROM ${this._table}${buildWhere()}`
            result = await this._pool.query(sql, params)
            const count = parseInt(result.rows[0]?.count || 0)
            return { data: null, error: null, count }
          }

          // Parse relations from select string
          const { mainCols, relations } = parseSelectCols(this._selectCols)

          // Auto-include FK columns needed for relation linking
          const extraCols = new Set()
          if (relations.length && !mainCols.includes('*')) {
            for (const rel of relations) {
              const actualTable = rel.table.replace('!inner', '')
              const fkKey = `${this._table}:${actualTable}`
              const fkEntries = _fkMap?.get(fkKey)
              if (fkEntries?.length) {
                const [fkTable, fkCol] = fkEntries[0].from.split('.')
                if (fkTable === this._table && !mainCols.includes(fkCol)) extraCols.add(fkCol)
                const [, refCol] = fkEntries[0].to.split('.')
                if (fkEntries[0].to.split('.')[0] === this._table && !mainCols.includes(refCol)) extraCols.add(refCol)
              }
            }
          }

          // Main query (no JOINs — relations fetched separately)
          const allCols = [...mainCols, ...extraCols]
          const colList = allCols.length ? allCols.join(', ') : '*'
          sql = `SELECT ${colList} FROM ${this._table}${buildWhere()}`
          if (this._orders.length) sql += ` ORDER BY ${this._orders.join(', ')}`
          if (this._limitVal != null) sql += ` LIMIT ${addParam(this._limitVal)}`
          if (this._offsetVal != null) sql += ` OFFSET ${addParam(this._offsetVal)}`

          result = await this._pool.query(sql, params)
          let data = result.rows

          // Fetch relations as separate queries (like PostgREST)
          if (relations.length > 0 && data.length > 0) {
            for (const rel of relations) {
              await fetchRelation(this._pool, data, this._table, rel)
            }
          }

          if (this._returnSingle) {
            if (data.length === 0) return { data: null, error: { message: 'Row not found', code: 'PGRST116' } }
            return { data: data[0], error: null }
          }
          if (this._returnMaybeSingle) {
            return { data: data[0] || null, error: null }
          }
          return { data, error: null }
        }

        case 'insert': {
          const rows = this._data
          if (!rows.length) return { data: [], error: null }

          const allCols = [...new Set(rows.flatMap(r => Object.keys(r)))]
          const valueRows = rows.map(row => {
            return `(${allCols.map(col => {
              const val = row[col]
              if (val === undefined || val === null) return 'DEFAULT'
              return addParam(pgVal(val))
            }).join(', ')})`
          })

          let insertReturnCols = '*'
          let insertRelations = []
          if (this._returnSelect) {
            const parsed = parseSelectCols(this._returnSelect)
            insertReturnCols = parsed.mainCols.join(', ')
            insertRelations = parsed.relations
          }

          sql = `INSERT INTO ${this._table} (${allCols.join(', ')}) VALUES ${valueRows.join(', ')}`
          if (this._returnSelect) sql += ` RETURNING ${insertReturnCols}`

          result = await this._pool.query(sql, params)
          let data = this._returnSelect ? result.rows : null

          if (insertRelations.length && data?.length) {
            for (const rel of insertRelations) await fetchRelation(this._pool, data, this._table, rel)
          }

          if (this._returnSingle) return { data: data?.[0] || null, error: null }
          return { data, error: null }
        }

        case 'update': {
          const setClauses = Object.entries(this._data)
            .map(([col, val]) => {
              if (val === undefined) return null
              if (val === null) return `${col} = NULL`
              return `${col} = ${addParam(pgVal(val))}`
            })
            .filter(Boolean)

          if (!setClauses.length) return { data: null, error: null }

          // Parse returnSelect for relations (e.g., '*, campaign_roles(*)')
          let returnCols = '*'
          let returnRelations = []
          if (this._returnSelect) {
            const parsed = parseSelectCols(this._returnSelect)
            returnCols = parsed.mainCols.join(', ')
            returnRelations = parsed.relations
          }

          sql = `UPDATE ${this._table} SET ${setClauses.join(', ')}${buildWhere()}`
          if (this._returnSelect) sql += ` RETURNING ${returnCols}`

          result = await this._pool.query(sql, params)
          let data = this._returnSelect ? result.rows : null

          // Fetch relations for returned rows (like SELECT)
          if (returnRelations.length && data?.length) {
            for (const rel of returnRelations) {
              await fetchRelation(this._pool, data, this._table, rel)
            }
          }

          if (this._returnSingle) return { data: data?.[0] || null, error: null }
          return { data, error: null }
        }

        case 'upsert': {
          const rows = this._data
          if (!rows.length) return { data: [], error: null }

          const allCols = [...new Set(rows.flatMap(r => Object.keys(r)))]
          const valueRows = rows.map(row => {
            return `(${allCols.map(col => {
              const val = row[col]
              if (val === undefined || val === null) return 'NULL'
              return addParam(pgVal(val))
            }).join(', ')})`
          })

          const conflictCols = this._upsertOptions.onConflict || 'id'
          const ignoreDuplicates = this._upsertOptions.ignoreDuplicates

          sql = `INSERT INTO ${this._table} (${allCols.join(', ')}) VALUES ${valueRows.join(', ')}`
          sql += ` ON CONFLICT (${conflictCols})`

          if (ignoreDuplicates) {
            sql += ' DO NOTHING'
          } else {
            const updateCols = allCols.filter(c => !conflictCols.split(',').map(s => s.trim()).includes(c))
            if (updateCols.length) {
              sql += ` DO UPDATE SET ${updateCols.map(c => `${c} = EXCLUDED.${c}`).join(', ')}`
            } else {
              sql += ' DO NOTHING'
            }
          }

          let upsertReturnCols = '*'
          let upsertRelations = []
          if (this._returnSelect) {
            const parsed = parseSelectCols(this._returnSelect)
            upsertReturnCols = parsed.mainCols.join(', ')
            upsertRelations = parsed.relations
          }
          if (this._returnSelect) sql += ` RETURNING ${upsertReturnCols}`

          result = await this._pool.query(sql, params)
          let data = this._returnSelect ? result.rows : null

          if (upsertRelations.length && data?.length) {
            for (const rel of upsertRelations) await fetchRelation(this._pool, data, this._table, rel)
          }

          if (this._returnSingle) return { data: data?.[0] || null, error: null }
          return { data, error: null }
        }

        case 'delete': {
          sql = `DELETE FROM ${this._table}${buildWhere()}`
          if (this._returnSelect) sql += ` RETURNING ${this._returnSelect === '*' ? '*' : this._returnSelect}`
          result = await this._pool.query(sql, params)
          return { data: this._returnSelect ? result.rows : null, error: null }
        }

        default:
          return { data: null, error: { message: `Unknown operation: ${this._operation}` } }
      }
    } catch (err) {
      return { data: null, error: { message: err.message, code: err.code, details: err.detail } }
    }
  }
}

/**
 * Parse select columns — separate main columns from relation references.
 * Relations are fetched as separate queries (not JOINs) to match PostgREST behavior.
 */
function parseSelectCols(cols) {
  if (!cols || cols === '*') return { mainCols: ['*'], relations: [] }

  const tokens = tokenizeSelect(cols)
  const mainCols = []
  const relations = []

  for (const token of tokens) {
    const relMatch = token.match(/^([\w!]+)\((.+)\)$/)
    if (relMatch) {
      relations.push({ table: relMatch[1], cols: relMatch[2] })
    } else {
      mainCols.push(token)
    }
  }

  return { mainCols: mainCols.length ? mainCols : ['*'], relations }
}

/**
 * Fetch a relation as a separate query and attach to parent rows as nested objects.
 * Produces results like PostgREST: { id, name, proxies: {...}, campaign_roles: [{...}] }
 */
async function fetchRelation(pool, parentRows, parentTable, rel) {
  const isInner = rel.table.includes('!')
  const actualTable = rel.table.replace('!inner', '')

  // Find FK from cached map
  const fkKey = `${parentTable}:${actualTable}`
  const fkEntries = _fkMap?.get(fkKey)

  let fkTable, fkCol, refTable, refCol

  if (fkEntries?.length) {
    const fk = fkEntries[0]
    ;[fkTable, fkCol] = fk.from.split('.')
    ;[refTable, refCol] = fk.to.split('.')
  } else {
    // Heuristic: child.parent_singular_id → parent.id
    const parentSingular = parentTable.replace(/s$/, '').replace(/ie$/, 'y')
    fkTable = actualTable
    fkCol = `${parentSingular}_id`
    refTable = parentTable
    refCol = 'id'
  }

  // Direction: does parent have FK (one-to-one) or child has FK (one-to-many)?
  const parentHasFK = (fkTable === parentTable)

  // Parse sub-relations from relCols
  const { mainCols: subMainCols, relations: subRelations } = parseSelectCols(rel.cols)
  const selectCols = subMainCols.includes('*') ? '*' : [...new Set([...subMainCols, 'id'])].join(', ')

  if (parentHasFK) {
    // Parent has FK → one-to-one (e.g., accounts.proxy_id → proxies.id)
    const fkValues = [...new Set(parentRows.map(r => r[fkCol]).filter(v => v != null))]
    if (!fkValues.length) {
      parentRows.forEach(r => { r[actualTable] = null })
      return
    }
    const ph = fkValues.map((_, i) => `$${i + 1}`)
    const { rows: relRows } = await pool.query(
      `SELECT ${selectCols} FROM ${actualTable} WHERE ${refCol} IN (${ph.join(',')})`, fkValues
    )
    if (subRelations.length && relRows.length) {
      for (const sub of subRelations) await fetchRelation(pool, relRows, actualTable, sub)
    }
    const relMap = new Map(relRows.map(r => [String(r[refCol]), r]))
    for (let i = parentRows.length - 1; i >= 0; i--) {
      parentRows[i][actualTable] = relMap.get(String(parentRows[i][fkCol])) || null
      if (isInner && !parentRows[i][actualTable]) parentRows.splice(i, 1)
    }
  } else {
    // Child has FK → one-to-many (e.g., campaign_roles.campaign_id → campaigns.id)
    const parentIds = [...new Set(parentRows.map(r => r[refCol]).filter(v => v != null))]
    if (!parentIds.length) {
      parentRows.forEach(r => { r[actualTable] = [] })
      return
    }
    // Ensure FK col is in SELECT for grouping
    const selWithFK = selectCols === '*' ? '*' : [...new Set([...selectCols.split(',').map(s=>s.trim()), fkCol])].join(', ')
    const ph = parentIds.map((_, i) => `$${i + 1}`)
    const { rows: relRows } = await pool.query(
      `SELECT ${selWithFK} FROM ${actualTable} WHERE ${fkCol} IN (${ph.join(',')})`, parentIds
    )
    if (subRelations.length && relRows.length) {
      for (const sub of subRelations) await fetchRelation(pool, relRows, actualTable, sub)
    }
    const relMap = new Map()
    for (const r of relRows) {
      const key = String(r[fkCol])
      if (!relMap.has(key)) relMap.set(key, [])
      relMap.get(key).push(r)
    }
    for (let i = parentRows.length - 1; i >= 0; i--) {
      parentRows[i][actualTable] = relMap.get(String(parentRows[i][refCol])) || []
      if (isInner && !parentRows[i][actualTable].length) parentRows.splice(i, 1)
    }
  }
}

/**
 * Split select string by top-level commas (respecting parentheses)
 */
function tokenizeSelect(str) {
  const tokens = []
  let depth = 0
  let current = ''
  for (const ch of str) {
    if (ch === '(') { depth++; current += ch }
    else if (ch === ')') { depth--; current += ch }
    else if (ch === ',' && depth === 0) {
      if (current.trim()) tokens.push(current.trim())
      current = ''
    } else { current += ch }
  }
  if (current.trim()) tokens.push(current.trim())
  return tokens
}

/**
 * Execute RPC (stored function) call
 */
async function rpcCall(pool, fnName, params) {
  try {
    const paramEntries = Object.entries(params || {})
    const paramNames = paramEntries.map(([k]) => k)
    const paramValues = paramEntries.map(([, v]) => v)
    const placeholders = paramValues.map((_, i) => `$${i + 1}`)

    // Call as: SELECT * FROM fn_name(param1 := $1, param2 := $2)
    const namedParams = paramNames.map((name, i) => `${name} := ${placeholders[i]}`)
    const sql = `SELECT * FROM ${fnName}(${namedParams.join(', ')})`

    const result = await pool.query(sql, paramValues)
    // Return all rows (Supabase rpc returns array by default)
    return { data: result.rows, error: null }
  } catch (err) {
    return { data: null, error: { message: err.message, code: err.code } }
  }
}

module.exports = { createClient }
