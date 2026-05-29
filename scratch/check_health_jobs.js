const { Client } = require('pg');
require('dotenv').config();

const client = new Client({
  connectionString: process.env.DATABASE_URL
});

(async () => {
  await client.connect();
  console.log('Connected to PostgreSQL Database on VPS');

  // Query status of the check_health jobs we just inserted
  const jobsRes = await client.query(`
    SELECT id, status, started_at, finished_at, error_message, payload
    FROM jobs 
    WHERE type = 'check_health'
    ORDER BY created_at DESC
    LIMIT 6
  `);
  console.log('\n--- The check_health Audit Jobs ---');
  for (const job of jobsRes.rows) {
    console.log(`Job ID: ${job.id}`);
    console.log(`Status: ${job.status}`);
    console.log(`Started At: ${job.started_at}`);
    console.log(`Finished At: ${job.finished_at}`);
    console.log(`Error: ${job.error_message}`);
    console.log(`Payload: ${JSON.stringify(job.payload)}`);
    console.log(`------------------------------------------`);
  }

  // Query 10 most recent comments of today (no 15-minute restriction, simple date comparison)
  const commentsRes = await client.query(`
    SELECT created_at, source_name, post_url, comment_text, status, error_message
    FROM comment_logs
    ORDER BY created_at DESC
    LIMIT 10
  `);
  console.log('\n--- 10 Most Recent Comment Logs ---');
  for (const c of commentsRes.rows) {
    console.log(`- [${c.created_at}] Group/Source: ${c.source_name}`);
    console.log(`  Post: ${c.post_url}`);
    console.log(`  Comment: ${c.comment_text}`);
    console.log(`  Status: ${c.status}, Error: ${c.error_message}`);
    console.log(`  ------------------------------------------`);
  }

  await client.end();
})();
