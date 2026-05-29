const { Client } = require('pg');
require('dotenv').config();

const client = new Client({
  connectionString: process.env.DATABASE_URL
});

(async () => {
  await client.connect();
  console.log('Connected to PostgreSQL Database on VPS');

  const campaign_id = 'b41bee21-2d52-48ca-ba21-357d6dd5ee0c'; // Tino
  const account_id = 'f946db84-b34d-48b7-9206-81b4c1b59d8a'; // Lorena Cezara

  // Let's run a raw SQL version of the campaign_groups inner join fb_groups query
  const res = await client.query(`
    SELECT cg.id, cg.score, cg.tier, cg.status, cg.last_nurtured_at,
           fg.id as fb_group_id_db, fg.fb_group_id, fg.name, fg.url, fg.is_member, fg.pending_approval, fg.is_blocked, fg.user_approved
    FROM campaign_groups cg
    INNER JOIN fb_groups fg ON cg.group_id = fg.id
    WHERE cg.campaign_id = $1 AND cg.assigned_nick_id = $2 AND cg.status = 'active'
  `, [campaign_id, account_id]);

  console.log(`\nFound ${res.rows.length} rows for Lorena Cezara in campaign_groups:`);
  for (const r of res.rows) {
    console.log(JSON.stringify(r, null, 2));
  }

  await client.end();
})();
