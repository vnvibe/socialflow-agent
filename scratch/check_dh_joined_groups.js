const { Client } = require('pg');
require('dotenv').config();

const client = new Client({
  connectionString: process.env.DATABASE_URL
});

(async () => {
  try {
    await client.connect();
    console.log('Connected to PostgreSQL Database on VPS');

    const dhId = 'aeb73391-53ed-409b-9dbe-181a8b2679fd'; // Diệu Hiền

    // Query joined groups of Diệu Hiền
    const joinedRes = await client.query(`
      SELECT id, fb_group_id, name, is_member, pending_approval, is_active
      FROM fb_groups
      WHERE account_id = $1 AND is_member = true AND is_active = true
    `, [dhId]);

    console.log(`\n--- Joined & Active Groups for Diệu Hiền (${joinedRes.rows.length} total) ---`);
    for (const g of joinedRes.rows) {
      console.log(`- "${g.name}" (FB ID: ${g.fb_group_id})`);
    }

    // Let's also see if any of these are assigned to Campaign Tino
    const tinoRes = await client.query("SELECT id, name FROM campaigns WHERE name = 'Tino'");
    if (tinoRes.rows.length > 0) {
      const tinoId = tinoRes.rows[0].id;
      const tinoJoinedRes = await client.query(`
        SELECT g.name, g.fb_group_id, cg.status
        FROM campaign_groups cg
        JOIN fb_groups g ON cg.group_id = g.id
        WHERE cg.campaign_id = $1 AND g.account_id = $2 AND g.is_member = true
      `, [tinoId, dhId]);

      console.log(`\n--- Diệu Hiền's Joined Groups that are in Campaign Tino (${tinoJoinedRes.rows.length} total) ---`);
      for (const g of tinoJoinedRes.rows) {
        console.log(`- "${g.name}" (FB ID: ${g.fb_group_id}) [Junction Status: ${g.status}]`);
      }
    }

  } catch (err) {
    console.error(err);
  } finally {
    await client.end();
  }
})();
