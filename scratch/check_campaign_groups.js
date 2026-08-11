const { Client } = require('pg');
require('dotenv').config();

const client = new Client({
  connectionString: process.env.DATABASE_URL
});

async function run() {
  await client.connect();

  console.log('--- Fetching all active campaign_groups records ---');
  const res = await client.query(`
    SELECT cg.campaign_id, cg.group_id, cg.status, cg.assigned_nick_id, fg.name, fg.fb_group_id, fg.is_member, fg.user_approved
    FROM campaign_groups cg
    LEFT JOIN fb_groups fg ON cg.group_id = fg.id
    WHERE cg.status = 'active'
    ORDER BY cg.campaign_id, fg.fb_group_id
  `);
  console.log(res.rows);

  await client.end();
}

run().catch(console.error);
