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
    
    // 1. Check Accounts status
    const { rows: accounts } = await pool.query("SELECT id, username, status, is_active FROM accounts")
    console.log('\n=== Accounts Status ===')
    accounts.forEach(a => console.log(`  - Nick: ${a.username} | Status: ${a.status} | Active: ${a.is_active}`))

    // 2. Check Campaigns
    const { rows: campaigns } = await pool.query("SELECT id, name, status, is_active FROM campaigns")
    console.log('\n=== Campaigns ===')
    if (campaigns.length === 0) {
      console.log('  No campaigns found.')
    } else {
      campaigns.forEach(c => console.log(`  - Camp: ${c.name} | Status: ${c.status} | Active: ${c.is_active}`))
    }

    // 3. Check Jobs status
    const { rows: jobs } = await pool.query("SELECT status, COUNT(*) as count FROM jobs GROUP BY status")
    console.log('\n=== Jobs Summary in Database ===')
    if (jobs.length === 0) {
      console.log('  No jobs exist in database.')
    } else {
      jobs.forEach(j => console.log(`  - Status [${j.status}]: ${j.count}`))
    }

    // 4. Check active campaigns group distribution
    const { rows: cg } = await pool.query("SELECT COUNT(*) as count FROM campaign_groups")
    console.log(`\n=== Total Campaign-Group Roster entries: ${cg[0].count} ===`)

  } catch (err) {
    console.error('Database query error:', err.message)
  } finally {
    await pool.end()
  }
}

run()
