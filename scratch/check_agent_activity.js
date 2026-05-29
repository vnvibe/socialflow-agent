const { Client } = require('pg');
require('dotenv').config();

const client = new Client({
  connectionString: process.env.DATABASE_URL
});

(async () => {
  await client.connect();
  console.log('Connected to PostgreSQL Database on VPS');

  // Query recent comment logs
  const commentRes = await client.query(`
    SELECT created_at, source_name, post_url, comment_text, status, error_message
    FROM comment_logs
    ORDER BY created_at DESC
    LIMIT 5
  `);
  console.log('\n--- Recent Comment Logs ---');
  for (const c of commentRes.rows) {
    console.log(`- [${c.created_at}] Group/Source: ${c.source_name}`);
    console.log(`  Post: ${c.post_url}`);
    console.log(`  Comment: ${c.comment_text}`);
    console.log(`  Status: ${c.status}, Error: ${c.error_message}`);
    console.log(`  ------------------------------------------`);
  }

  // Query recent job failures
  const failuresRes = await client.query(`
    SELECT created_at, error_type, error_message, handler_name, page_url
    FROM job_failures
    ORDER BY created_at DESC
    LIMIT 5
  `);
  console.log('\n--- Recent Job Failures ---');
  for (const f of failuresRes.rows) {
    console.log(`- [${f.created_at}] Error Type: ${f.error_type}`);
    console.log(`  Handler: ${f.handler_name}, URL: ${f.page_url}`);
    console.log(`  Message: ${f.error_message}`);
    console.log(`  ------------------------------------------`);
  }

  // Query recent activity log entries
  const actRes = await client.query(`
    SELECT created_at, action_type, target_name, result_status, details
    FROM campaign_activity_log
    ORDER BY created_at DESC
    LIMIT 5
  `);
  console.log('\n--- Recent Activity Logs ---');
  for (const a of actRes.rows) {
    console.log(`- [${a.created_at}] Action: ${a.action_type}`);
    console.log(`  Target: ${a.target_name}, Status: ${a.result_status}`);
    console.log(`  Details: ${JSON.stringify(a.details)}`);
    console.log(`  ------------------------------------------`);
  }

  await client.end();
})();
