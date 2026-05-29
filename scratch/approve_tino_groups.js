const { Client } = require('pg');
require('dotenv').config();

const client = new Client({
  connectionString: process.env.DATABASE_URL
});

(async () => {
  await client.connect();
  console.log('Connected to PostgreSQL Database on VPS');

  // Let's dump column names of accounts to know what they are
  const accColumnsRes = await client.query(`
    SELECT column_name, data_type 
    FROM information_schema.columns 
    WHERE table_name = 'accounts'
  `);
  console.log('\n--- Columns in accounts ---');
  for (const col of accColumnsRes.rows) {
    console.log(`  - ${col.column_name} (${col.data_type})`);
  }

  // Find Campaign Tino
  const campaignRes = await client.query("SELECT id, name, status, goal FROM campaigns WHERE name = 'Tino'");
  if (campaignRes.rows.length === 0) {
    console.error('Campaign Tino not found!');
    await client.end();
    return;
  }
  const tino = campaignRes.rows[0];

  // We will UPDATE all groups in fb_groups linked to campaign Tino that are blocked due to pending_timeout
  // or user_approved = null
  console.log('\nUpdating groups for campaign Tino...');
  const updateRes = await client.query(`
    UPDATE fb_groups
    SET user_approved = true,
        is_blocked = false,
        blocked_reason = null,
        is_member = true,
        pending_approval = false
    WHERE id IN (
      SELECT group_id 
      FROM campaign_groups 
      WHERE campaign_id = $1
    )
  `, [tino.id]);

  console.log(`Updated ${updateRes.rowCount} groups in fb_groups!`);

  // Let's also verify that the campaign_groups rows are set to 'active'
  const updateJunctionRes = await client.query(`
    UPDATE campaign_groups
    SET status = 'active'
    WHERE campaign_id = $1
  `, [tino.id]);
  console.log(`Updated ${updateJunctionRes.rowCount} junction rows in campaign_groups!`);

  // Now, let's dump the updated group status to verify
  const cgRes = await client.query(`
    SELECT cg.status as junction_status, cg.assigned_nick_id,
           fg.fb_group_id, fg.name as group_name,
           fg.is_member, fg.pending_approval, fg.user_approved, fg.is_blocked, fg.blocked_reason
    FROM campaign_groups cg
    JOIN fb_groups fg ON cg.group_id = fg.id
    WHERE cg.campaign_id = $1
  `, [tino.id]);

  console.log(`\n--- AFTER UPDATE: Groups in Campaign Tino ---`);
  for (const r of cgRes.rows) {
    console.log(`- Group: "${r.group_name}" (${r.fb_group_id})`);
    console.log(`  Junction Status: ${r.junction_status}, Assigned Nick ID: ${r.assigned_nick_id}`);
    console.log(`  Group Status: is_member=${r.is_member}, pending_approval=${r.pending_approval}, user_approved=${r.user_approved}, is_blocked=${r.is_blocked}, reason=${r.blocked_reason}`);
    console.log(`  ------------------------------------------`);
  }

  await client.end();
})();
