const path = require('path')
const fs = require('fs')
require('dotenv').config({ path: path.join(__dirname, '../.env') })
const { Pool } = require('pg')

async function run() {
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) {
    console.error('DATABASE_URL not found in .env')
    process.exit(1)
  }

  const pool = new Pool({ connectionString })
  try {
    console.log('Connecting to database...')
    const { rows: before } = await pool.query("SELECT COUNT(*) as count, type FROM jobs WHERE status IN ('pending', 'running') GROUP BY type")
    console.log('Pending/running jobs in database before cleanup:')
    if (before.length === 0) {
      console.log('  (none)')
    } else {
      before.forEach(r => console.log(`  - ${r.type}: ${r.count}`))
    }

    // Delete all pending/running tasks
    const { rowCount } = await pool.query("DELETE FROM jobs WHERE status IN ('pending', 'running')")
    console.log(`\n[SUCCESS] Successfully purged ${rowCount} pending/running job(s) from database.`)
  } catch (err) {
    console.error('Error cleaning up jobs:', err.message)
  } finally {
    await pool.end()
  }
}

run()
