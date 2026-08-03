// DB client — Direct VPS PostgreSQL / VPS API. No Supabase.
// Priority: DATABASE_URL (direct PG) > API_URL (VPS HTTP proxy)

let config = {}
try { config = require('./config') } catch {}

const DATABASE_URL = process.env.DATABASE_URL || config.DATABASE_URL
const API_URL      = process.env.API_URL       || config.API_URL
const AGENT_SECRET = process.env.AGENT_SECRET  || process.env.AGENT_SECRET_KEY || config.AGENT_SECRET_KEY

let db

if (DATABASE_URL) {
  const { createClient } = require('./pg-db')
  db = createClient(DATABASE_URL)
  console.log('[DB] Direct PostgreSQL connected')
} else if (API_URL && AGENT_SECRET) {
  const { createClient } = require('./http-db')
  db = createClient(API_URL, AGENT_SECRET)
  console.log('[DB] VPS API proxy connected')
} else {
  console.error('[DB] ERROR: Set API_URL + AGENT_SECRET_KEY or DATABASE_URL in config or .env')
  process.exit(1)
}

// Backward-compatibility alias
const supabase = db

module.exports = { db, supabase, config }
