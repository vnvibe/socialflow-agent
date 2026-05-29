const { Client } = require('pg');
require('dotenv').config();

const client = new Client({
  connectionString: process.env.DATABASE_URL
});

(async () => {
  await client.connect();
  console.log('Connected to PostgreSQL Database on VPS');

  // Find Campaign Tino
  const campaignRes = await client.query("SELECT id, name, status, goal FROM campaigns WHERE name = 'Tino'");
  if (campaignRes.rows.length === 0) {
    console.error('Campaign Tino not found!');
    await client.end();
    return;
  }
  const tino = campaignRes.rows[0];
  console.log(`\nFound Campaign Tino: ID = ${tino.id}, Status = ${tino.status}`);

  // Query groups in campaign_groups for Tino
  const cgRes = await client.query(`
    SELECT cg.id as junction_id, cg.status as junction_status, cg.assigned_nick_id, cg.tier, cg.score,
           fg.id as group_db_id, fg.fb_group_id, fg.name as group_name, fg.url as group_url,
           fg.is_member, fg.pending_approval, fg.user_approved, fg.is_blocked, fg.blocked_reason, fg.account_id
    FROM campaign_groups cg
    JOIN fb_groups fg ON cg.group_id = fg.id
    WHERE cg.campaign_id = $1
  `, [tino.id]);

  console.log(`\n--- Groups in Campaign Tino (${cgRes.rows.length} total) ---`);
  for (const r of cgRes.rows) {
    console.log(`- Group Name: "${r.group_name}" (${r.fb_group_id})`);
    console.log(`  Junction Status: ${r.junction_status}, Assigned Nick ID: ${r.assigned_nick_id}`);
    console.log(`  Group Status: is_member=${r.is_member}, pending_approval=${r.pending_approval}, user_approved=${r.user_approved}, is_blocked=${r.is_blocked}, reason=${r.blocked_reason}`);
    console.log(`  ------------------------------------------`);
  }

  // Query all accounts in DB
  const accsRes = await client.query(`
    SELECT id, name, username, status, is_active, last_health_check_at, error_message
    FROM accounts
  `);
  console.log(`\n--- Accounts in Database (${accsRes.rows.length} total) ---`);
  for (const a of accsRes.rows) {
    console.log(`- Nick: "${a.name}" (${a.username})`);
    console.log(`  ID: ${a.id}`);
    console.log(`  Status: ${a.status}, Active: ${a.is_active}, Last Health Check: ${a.last_health_check_at}`);
    console.log(`  Error: ${a.error_message}`);
    console.log(`  ------------------------------------------`);
  }

  // Query pending jobs for campaign Tino
  const jobsRes = await client.query(`
    SELECT id, type, status, scheduled_at, started_at, error_message, payload
    FROM jobs
    WHERE status = 'pending' AND (payload->>'campaign_id' = $1 OR type = 'campaign_nurture')
  `, [tino.id]);
  console.log(`\n--- Pending Jobs for Tino / Nurture (${jobsRes.rows.length} total) ---`);
  for (const j of jobsRes.rows) {
    console.log(`- Job ID: ${j.id}, Type: ${j.type}, Status: ${j.status}, Scheduled At: ${j.scheduled_at}`);
    console.log(`  Payload: ${JSON.stringify(j.payload)}`);
  }

  await client.end();
})();
