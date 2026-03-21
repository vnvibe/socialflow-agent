const { createClient } = require('@supabase/supabase-js')

// Priority: env vars > embedded config (from build)
let config = {}
try {
  config = require('./config')
} catch {
  // config.js doesn't exist in dev mode — use .env only
}

const SUPABASE_URL = process.env.SUPABASE_URL || config.SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || config.SUPABASE_SERVICE_ROLE_KEY || config.SUPABASE_ANON_KEY

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('[ERROR] Missing Supabase credentials. Set SUPABASE_URL and SUPABASE_ANON_KEY (or SUPABASE_SERVICE_ROLE_KEY) in .env')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

module.exports = { supabase, config }
