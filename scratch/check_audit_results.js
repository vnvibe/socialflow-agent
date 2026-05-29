const { Client } = require('pg');
require('dotenv').config();

const client = new Client({
  connectionString: process.env.DATABASE_URL
});

(async () => {
  await client.connect();
  console.log('Connected to PostgreSQL Database on VPS');

  // Query jobs results
  const jobsRes = await client.query(`
    SELECT id, status, finished_at, error_message, result, payload
    FROM jobs 
    WHERE type = 'check_health'
    ORDER BY created_at DESC
    LIMIT 6
  `);
  console.log('\n--- The check_health Audit Jobs Results ---');
  for (const job of jobsRes.rows) {
    console.log(`Job ID: ${job.id}`);
    console.log(`Status: ${job.status}`);
    console.log(`Finished At: ${job.finished_at}`);
    console.log(`Error: ${job.error_message}`);
    console.log(`Result: ${JSON.stringify(job.result, null, 2)}`);
    console.log(`Payload: ${JSON.stringify(job.payload)}`);
    console.log(`------------------------------------------`);
  }

  // Query updated accounts status
  const accsRes = await client.query(`
    SELECT id, username, status, is_active, last_checked_at, last_error
    FROM accounts
    WHERE id IN (
      'f946db84-b34d-48b7-9206-81b4c1b59d8a',
      '2cdd5c69-6ba1-461a-8709-60644c64d4a0',
      '391ccadd-c811-428f-ac03-eeba8b093ce9',
      '349b0998-e193-4be6-8c7b-584d33c4d1d8',
      'a70814a5-94ba-47ef-ab4d-ae5fd9e08fbf',
      '6010461b-97fc-40ce-b407-8cddf18d40e1'
    )
  `);
  console.log('\n--- Updated Accounts Status after Audit ---');
  for (const a of accsRes.rows) {
    console.log(`- Username: "${a.username}"`);
    console.log(`  ID: ${a.id}`);
    console.log(`  Status: ${a.status}, Active: ${a.is_active}, Last Checked: ${a.last_checked_at}`);
    console.log(`  Last Error: ${a.last_error}`);
    console.log(`  ------------------------------------------`);
  }

  await client.end();
})();
