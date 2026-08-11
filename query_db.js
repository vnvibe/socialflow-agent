const { Client } = require('pg');

const client = new Client({
  connectionString: process.env.DATABASE_URL
});

async function main() {
  await client.connect();

  const tino6OwnerId = '7be4f007-c00d-4921-83a8-8a5000356bc7';

  console.log('=== 1. TODAY KPI PROGRESS (2026-08-03) ===');
  const { rows: kpiRows } = await client.query(`
    SELECT a.username, k.target_comments, k.done_comments, k.target_likes, k.done_likes, k.kpi_met
    FROM nick_kpi_daily k
    JOIN accounts a ON k.account_id = a.id
    WHERE a.owner_id = $1 AND k.date = CURRENT_DATE
    ORDER BY a.username;
  `, [tino6OwnerId]);
  console.log(JSON.stringify(kpiRows, null, 2));

  console.log('\n=== 2. PENDING COMMENT JOBS IN QUEUE ===');
  const { rows: pendingJobs } = await client.query(`
    SELECT j.id, j.type, j.status, j.priority, a.username, j.created_at, j.scheduled_at,
           ROUND(EXTRACT(EPOCH FROM (j.scheduled_at - NOW()))) as seconds_until_scheduled
    FROM jobs j
    JOIN accounts a ON (j.payload->>'account_id')::uuid = a.id
    WHERE a.owner_id = $1 AND j.status = 'pending'
    ORDER BY j.scheduled_at ASC;
  `, [tino6OwnerId]);
  console.log(JSON.stringify(pendingJobs, null, 2));

  console.log('\n=== 3. TODAY COMMENT LOGS ===');
  const { rows: cmtLogs } = await client.query(`
    SELECT l.id, a.username, l.post_url, l.comment_text, l.status, l.created_at
    FROM comment_logs l
    JOIN accounts a ON l.account_id = a.id
    WHERE a.owner_id = $1 AND l.created_at >= CURRENT_DATE
    ORDER BY l.created_at DESC LIMIT 10;
  `, [tino6OwnerId]);
  console.log(JSON.stringify(cmtLogs, null, 2));

  await client.end();
}

main().catch(err => { console.error(err); process.exit(1); });
