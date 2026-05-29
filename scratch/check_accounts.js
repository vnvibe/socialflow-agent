const { Client } = require('pg');
require('dotenv').config();

const client = new Client({
  connectionString: process.env.DATABASE_URL
});

(async () => {
  await client.connect();
  console.log('Connected to PostgreSQL Database on VPS');

  // Query all accounts in DB
  const accsRes = await client.query(`
    SELECT id, username, status, is_active, last_checked_at, last_error, profile_language
    FROM accounts
  `);
  console.log(`\n--- Accounts in Database (${accsRes.rows.length} total) ---`);
  for (const a of accsRes.rows) {
    console.log(`- Username: "${a.username}"`);
    console.log(`  ID: ${a.id}`);
    console.log(`  Status: ${a.status}, Active: ${a.is_active}, Last Checked: ${a.last_checked_at}`);
    console.log(`  Error: ${a.last_error}`);
    console.log(`  ------------------------------------------`);
  }

  // Find if there are any jobs currently running or pending
  const jobsRes = await client.query(`
    SELECT id, type, status, scheduled_at, started_at, error_message, payload
    FROM jobs
    WHERE status IN ('pending', 'running')
  `);
  console.log(`\n--- Pending/Running Jobs (${jobsRes.rows.length} total) ---`);
  for (const j of jobsRes.rows) {
    console.log(`- Job ID: ${j.id}, Type: ${j.type}, Status: ${j.status}, Scheduled At: ${j.scheduled_at}`);
    console.log(`  Payload: ${JSON.stringify(j.payload)}`);
  }

  await client.end();
})();
