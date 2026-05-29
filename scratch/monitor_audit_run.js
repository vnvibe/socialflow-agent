const { Client } = require('pg');
require('dotenv').config();

const client = new Client({
  connectionString: process.env.DATABASE_URL
});

(async () => {
  await client.connect();
  console.log('Connected to PostgreSQL Database on VPS');

  // Query 5 most recent campaign_nurture jobs of today
  const res = await client.query(`
    SELECT j.id, j.status, j.started_at, j.finished_at, j.error_message, j.agent_id,
           a.username as nick_name
    FROM jobs j
    LEFT JOIN accounts a ON j.payload->>'account_id' = a.id::text
    WHERE j.type = 'campaign_nurture'
    ORDER BY j.created_at DESC
    LIMIT 5
  `);
  console.log('\n======================================================');
  console.log('         CAMPAIGN NURTURE RUNNING STATUS');
  console.log('======================================================');
  for (const job of res.rows) {
    console.log(`- Nick: "${job.nick_name || 'Unknown'}"`);
    console.log(`  Job ID: ${job.id}`);
    console.log(`  Status: ${job.status} (Agent: ${job.agent_id})`);
    console.log(`  Started At: ${job.started_at}`);
    console.log(`  Finished At: ${job.finished_at}`);
    console.log(`  Error: ${job.error_message}`);
    console.log(`  --------------------------------------------------`);
  }

  // Query 5 most recent comments
  const commentsRes = await client.query(`
    SELECT c.created_at, c.source_name, c.comment_text, c.status, c.error_message,
           a.username as nick_name
    FROM comment_logs c
    LEFT JOIN accounts a ON c.account_id = a.id
    ORDER BY c.created_at DESC
    LIMIT 5
  `);
  console.log('\n======================================================');
  console.log('              RECENT COMMENTS POSTED');
  console.log('======================================================');
  if (commentsRes.rows.length === 0) {
    console.log('No comments posted yet today.');
  } else {
    for (const c of commentsRes.rows) {
      console.log(`- [${c.created_at}] Nick: "${c.nick_name || 'Unknown'}"`);
      console.log(`  Group: "${c.source_name}"`);
      console.log(`  Comment: "${c.comment_text}"`);
      console.log(`  Status: ${c.status} (Error: ${c.error_message})`);
      console.log(`  --------------------------------------------------`);
    }
  }

  // Query recent job failures
  const failuresRes = await client.query(`
    SELECT f.created_at, f.error_type, f.error_message, f.handler_name,
           a.username as nick_name
    FROM job_failures f
    LEFT JOIN accounts a ON f.account_id = a.id
    ORDER BY f.created_at DESC
    LIMIT 3
  `);
  console.log('\n======================================================');
  console.log('               RECENT AUDIT ERRORS');
  console.log('======================================================');
  if (failuresRes.rows.length === 0) {
    console.log('No recent job errors.');
  } else {
    for (const f of failuresRes.rows) {
      console.log(`- [${f.created_at}] Nick: "${f.nick_name || 'Unknown'}"`);
      console.log(`  Handler: ${f.handler_name}, Type: ${f.error_type}`);
      console.log(`  Message: ${f.error_message}`);
      console.log(`  --------------------------------------------------`);
    }
  }

  await client.end();
})();
