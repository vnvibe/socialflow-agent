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
    console.log('Querying campaign groups mapping in database...')
    const { rows } = await pool.query(`
      SELECT cg.id as cg_row_id, cg.campaign_id, cg.assigned_nick_id, cg.status as cg_status,
             g.id as group_row_id, g.fb_group_id, g.name as group_name, g.is_member,
             a.username as nick_name
      FROM campaign_groups cg
      JOIN fb_groups g ON cg.group_id = g.id
      JOIN accounts a ON cg.assigned_nick_id = a.id
      WHERE cg.campaign_id = 'b41bee21-2d52-48ca-ba21-357d6dd5ee0c'
    `)
    
    console.log(`\n=== Tino Campaign Groups (${rows.length} entries) ===`)
    rows.forEach((r, i) => {
      console.log(`  ${i+1}. Nick: [${r.nick_name}] | Group Name: [${r.group_name}] | FB ID: [${r.fb_group_id}] | Member: [${r.is_member}] | Status: [${r.cg_status}]`)
    })

  } catch (err) {
    console.error('Database query error:', err.message)
  } finally {
    await pool.end()
  }
}

run()
