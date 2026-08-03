const { Client } = require('pg');
require('dotenv').config();

const client = new Client({
  connectionString: process.env.DATABASE_URL
});

async function checkStatus() {
  await client.connect();
  console.log('--- Checking FB Group: vnhermesagent ---');

  const fbRes = await client.query(`
    SELECT fg.id, fg.account_id, fg.fb_group_id, fg.is_member, fg.pending_approval, fg.joined_at, a.notes, a.username
    FROM fb_groups fg
    LEFT JOIN accounts a ON fg.account_id = a.id
    WHERE fg.fb_group_id = 'vnhermesagent'
  `);
  console.log('\nfb_groups rows:');
  console.table(fbRes.rows);

  const cgRes = await client.query(`
    SELECT cg.campaign_id, cg.group_id, cg.assigned_nick_id, cg.status, c.name as campaign_name
    FROM campaign_groups cg
    JOIN fb_groups fg ON cg.group_id = fg.id
    JOIN campaigns c ON cg.campaign_id = c.id
    WHERE fg.fb_group_id = 'vnhermesagent'
  `);
  console.log('\ncampaign_groups rows:');
  console.table(cgRes.rows);

  const jobRes = await client.query(`
    SELECT j.id, j.type, j.status, j.payload->>'account_id' as account_id, j.payload->>'group_url' as group_url, j.created_at
    FROM jobs j
    WHERE j.payload->>'fb_group_id' = 'vnhermesagent'
    ORDER BY j.created_at DESC
  `);
  console.log('\njobs for vnhermesagent:');
  console.table(jobRes.rows);

  await client.end();
}

checkStatus().catch(console.error);
