require('dotenv').config()
const { Client } = require('pg')

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL })
  await client.connect()

  const r = await client.query(`
    UPDATE jobs 
    SET created_by = '7be4f007-c00d-4921-83a8-8a5000356bc7' 
    WHERE status = 'pending'
  `)
  console.log(`Updated ${r.rowCount} pending jobs to campaign owner ID '7be4f007-c00d-4921-83a8-8a5000356bc7'.`)

  await client.end()
}

main().catch(console.error)
