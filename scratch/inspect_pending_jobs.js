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
    console.log('Querying pending jobs detail...')
    const { rows } = await pool.query(`
      SELECT * 
      FROM jobs 
      WHERE status = 'pending'
    `)
    
    console.log(`\nFound ${rows.length} pending job(s):`)
    rows.forEach((r, i) => {
      console.log(`\n[Job #${i+1}]`, r)
    })

  } catch (err) {
    console.error('Database query error:', err.message)
  } finally {
    await pool.end()
  }
}

run()
