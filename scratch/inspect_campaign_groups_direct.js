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
    console.log('Querying campaign_groups directly for specific group IDs...')
    
    // Query campaign_groups using join or directly
    const { rows } = await pool.query(`
      SELECT cg.*, g.name as g_name, g.fb_group_id as g_fb_id 
      FROM campaign_groups cg
      LEFT JOIN fb_groups g ON cg.group_id = g.id
      WHERE g.fb_group_id IN ('crickfoot', 'readymom', '1495754813979307')
    `)
    
    console.log(`\nFound ${rows.length} entry/entries in campaign_groups:`)
    rows.forEach(r => {
      console.log(r)
    })

  } catch (err) {
    console.error('Database query error:', err.message)
  } finally {
    await pool.end()
  }
}

run()
