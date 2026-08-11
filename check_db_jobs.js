const { Client } = require('pg');
require('dotenv').config();

const client = new Client({
  connectionString: process.env.DATABASE_URL
});

async function run() {
  await client.connect();
  console.log('Fetching today\'s jobs...');

  const today = new Date(Date.now() + 7 * 3600000).toISOString().split('T')[0];
  const res = await client.query(`
    SELECT id, type, status, scheduled_at, error_message, payload->'account_id' as account_id 
    FROM jobs 
    WHERE created_at >= $1
    ORDER BY created_at DESC
  `, [today]);

  console.log(`Found ${res.rows.length} jobs created today (${today}):`);
  for (const r of res.rows) {
    const acc = await client.query(`SELECT username FROM accounts WHERE id = $1`, [r.account_id]);
    console.log(`- Job: ${r.type} | Status: ${r.status} | Account: ${acc.rows[0]?.username || r.account_id} | Scheduled: ${r.scheduled_at} | Error: ${r.error_message}`);
  }

  await client.end();
}

run().catch(console.error);
