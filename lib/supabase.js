// Priority: DATABASE_URL (self-hosted) > Supabase cloud

let config = {}
try {
  config = require('./config')
} catch {
  // config.js doesn't exist in dev mode — use .env only
}

const DATABASE_URL = process.env.DATABASE_URL || config.DATABASE_URL

let supabase

if (DATABASE_URL) {
  // Self-hosted PostgreSQL via drop-in wrapper
  const { createClient } = require('./pg-supabase')
  supabase = createClient(DATABASE_URL)
  console.log('[DB] Using self-hosted PostgreSQL')
} else {
  // Supabase cloud (legacy)
  const { createClient } = require('@supabase/supabase-js')
  const SUPABASE_URL = process.env.SUPABASE_URL || config.SUPABASE_URL
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || config.SUPABASE_SERVICE_ROLE_KEY || config.SUPABASE_ANON_KEY

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('[ERROR] Missing database credentials. Set DATABASE_URL or SUPABASE_URL + key in .env')
    process.exit(1)
  }

  supabase = createClient(SUPABASE_URL, SUPABASE_KEY)
  console.log('[DB] Using Supabase cloud')
}

module.exports = { supabase, config }
