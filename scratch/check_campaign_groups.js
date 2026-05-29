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
    console.log('Querying campaign groups in database...')
    
    // 1. Get campaign ID for Tino campaign
    const { rows: camp } = await pool.query("SELECT id, name FROM campaigns WHERE name = 'Tino' OR is_active = true")
    console.log('\n=== Campaigns in Database ===')
    camp.forEach(c => console.log(`  - ${c.name} (ID: ${c.id})`))
    
    if (camp.length === 0) {
      console.log('No active campaigns found.')
      return
    }

    // 2. Query all groups in campaign_groups
    const { rows: groups } = await pool.query(`
      SELECT * FROM campaign_groups
    `)
    
    console.log('\n=== Groups in campaign_groups ===')
    groups.forEach((g, i) => {
      console.log(`  ${i+1}.`, g)
    })

  } catch (err) {
    console.error('Database query error:', err.message)
  } finally {
    await pool.end()
  }
}

run()
