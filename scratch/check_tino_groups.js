const { Client } = require('pg');
require('dotenv').config();

const client = new Client({
  connectionString: process.env.DATABASE_URL
});

(async () => {
  try {
    await client.connect();
    console.log('Connected to PostgreSQL Database on VPS');

    // 1. Get Campaign Tino ID
    const cRes = await client.query("SELECT id, name, status FROM campaigns WHERE name = 'Tino'");
    if (cRes.rows.length === 0) {
      console.error('Campaign Tino not found!');
      await client.end();
      return;
    }
    const tino = cRes.rows[0];
    console.log(`\nCampaign found: "${tino.name}" (ID: ${tino.id}, Status: ${tino.status})`);

    // 2. Query groups mapped to this campaign via campaign_groups junction table
    const cgRes = await client.query(`
      SELECT cg.id as cg_id, cg.status as cg_status, cg.tier,
             g.id as group_id, g.fb_group_id, g.name as group_name, g.url as group_url,
             g.is_member, g.pending_approval, g.is_active
      FROM campaign_groups cg
      JOIN fb_groups g ON cg.group_id = g.id
      WHERE cg.campaign_id = $1
    `, [tino.id]);

    console.log(`\n--- Groups mapped to Campaign Tino via campaign_groups (${cgRes.rows.length} total) ---`);
    for (const g of cgRes.rows) {
      console.log(`- Group Name: "${g.group_name}"`);
      console.log(`  FB Group ID: ${g.fb_group_id}, ID: ${g.group_id}`);
      console.log(`  Junction Status: ${g.cg_status}, Group Active: ${g.is_active}, Is Member: ${g.is_member}`);
      console.log(`  URL: ${g.group_url}`);
      console.log('  ------------------------------------------');
    }

    // 3. Query all fb_groups assigned to our active account "Diệu Hiền" (ID: aeb73391-53ed-409b-9dbe-181a8b2679fd)
    const dhId = 'aeb73391-53ed-409b-9dbe-181a8b2679fd';
    const fgRes = await client.query(`
      SELECT id, fb_group_id, name, is_member, pending_approval, is_active
      FROM fb_groups
      WHERE account_id = $1 AND is_active = true
    `, [dhId]);

    console.log(`\n--- Active groups under account "Diệu Hiền" (${fgRes.rows.length} total) ---`);
    for (const g of fgRes.rows) {
      console.log(`- "${g.name}" (FB ID: ${g.fb_group_id}) | Is Member: ${g.is_member}, Pending: ${g.pending_approval}`);
    }

  } catch (err) {
    console.error(err);
  } finally {
    await client.end();
  }
})();
