const { Client } = require('pg');
require('dotenv').config();

const client = new Client({
  connectionString: process.env.DATABASE_URL
});

(async () => {
  await client.connect();
  console.log('Connected to PostgreSQL Database on VPS');

  // Reset any running/claimed jobs back to pending
  const resetRes = await client.query(`
    UPDATE jobs
    SET status = 'pending',
        agent_id = null,
        started_at = null,
        error_message = null,
        scheduled_at = now()
    WHERE status IN ('running', 'claimed') AND type IN ('check_health', 'campaign_nurture')
  `);
  console.log(`Reset ${resetRes.rowCount} stuck jobs back to pending!`);

  // Ensure accounts are active for audit
  const accRes = await client.query(`
    UPDATE accounts
    SET is_active = true
    WHERE id IN (
      'f946db84-b34d-48b7-9206-81b4c1b59d8a',
      '2cdd5c69-6ba1-461a-8709-60644c64d4a0',
      '391ccadd-c811-428f-ac03-eeba8b093ce9',
      '349b0998-e193-4be6-8c7b-584d33c4d1d8',
      'a70814a5-94ba-47ef-ab4d-ae5fd9e08fbf',
      '6010461b-97fc-40ce-b407-8cddf18d40e1'
    )
  `);
  console.log(`Ensured 6 audit accounts are is_active = true in DB.`);

  await client.end();
})();
