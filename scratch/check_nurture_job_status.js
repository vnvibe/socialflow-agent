const { Client } = require('pg');
require('dotenv').config();

const client = new Client({
  connectionString: process.env.DATABASE_URL
});

(async () => {
  await client.connect();
  console.log('Connected to PostgreSQL Database on VPS');

  // Query 3 most recent campaign_nurture jobs
  const res = await client.query(`
    SELECT id, status, started_at, finished_at, attempt, max_attempts, error_message, result
    FROM jobs 
    WHERE type = 'campaign_nurture'
    ORDER BY created_at DESC
    LIMIT 3
  `);
  console.log('\n--- Recent Nurture Jobs ---');
  for (const job of res.rows) {
    console.log(`Job ID: ${job.id}`);
    console.log(`Status: ${job.status}`);
    console.log(`Started At: ${job.started_at}`);
    console.log(`Finished At: ${job.finished_at}`);
    console.log(`Attempt: ${job.attempt} / ${job.max_attempts}`);
    console.log(`Error: ${job.error_message}`);
    console.log(`Result: ${JSON.stringify(job.result, null, 2)}`);
    console.log(`------------------------------------------`);
  }

  // Also query recent comments within the last 15 minutes
  const recentComments = await client.query(`
    SELECT created_at, source_name, post_url, comment_text, status, error_message
    FROM comment_logs
    WHERE created_at >= now() - interval '15 minutes'
    ORDER BY created_at DESC
  `);
  console.log(`\n--- Comments in the last 15 minutes (${recentComments.rows.length} total) ---`);
  for (const c of recentComments.rows) {
    console.log(`- [${c.created_at}] Group/Source: ${c.source_name}`);
    console.log(`  Post: ${c.post_url}`);
    console.log(`  Comment: ${c.comment_text}`);
    console.log(`  Status: ${c.status}, Error: ${c.error_message}`);
    console.log(`  ------------------------------------------`);
  }

  // Also query recent activity logs within the last 15 minutes
  const recentActivity = await client.query(`
    SELECT created_at, action_type, target_name, result_status, details
    FROM campaign_activity_log
    WHERE created_at >= now() - interval '15 minutes'
    ORDER BY created_at DESC
  `);
  console.log(`\n--- Activity logs in the last 15 minutes (${recentActivity.rows.length} total) ---`);
  for (const a of recentActivity.rows) {
    console.log(`- [${a.created_at}] Action: ${a.action_type}`);
    console.log(`  Target: ${a.target_name}, Status: ${a.result_status}`);
    console.log(`  Details: ${JSON.stringify(a.details)}`);
    console.log(`  ------------------------------------------`);
  }

  await client.end();
})();
