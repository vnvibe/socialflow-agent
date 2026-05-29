const { Client } = require('pg');
require('dotenv').config();

const client = new Client({
  connectionString: process.env.DATABASE_URL
});

(async () => {
  try {
    await client.connect();
    console.log('Connected to PostgreSQL Database on VPS');

    const campaignId = 'b41bee21-2d52-48ca-ba21-357d6dd5ee0c'; // Tino
    const vietNguyenId = '2cdd5c69-6ba1-461a-8709-60644c64d4a0';
    const lorenaId = 'f946db84-b34d-48b7-9206-81b4c1b59d8a';
    const groupFbId = '852586990732832';
    
    console.log('\n--- 1. Cleaning up duplicate group assignment for expired nick ---');
    // Remove group 852586990732832 link from Lorena Cezara (expired) in campaign_groups
    const deleteRes = await client.query(`
      DELETE FROM campaign_groups 
      WHERE campaign_id = $1 
        AND assigned_nick_id = $2 
        AND group_id IN (SELECT id FROM fb_groups WHERE fb_group_id = $3)
    `, [campaignId, lorenaId, groupFbId]);
    console.log(`Removed ${deleteRes.rowCount} stale group assignment(s) for Lorena Cezara.`);

    console.log('\n--- 2. Assigning "OpenClaw AI Kiếm Cơm" group to Việt Nguyễn ---');
    // Find the group row id for "OpenClaw AI Kiếm Cơm" belonging to Việt Nguyễn
    const groupRes = await client.query(`
      SELECT id FROM fb_groups 
      WHERE fb_group_id = '1183213533741931' AND account_id = $1
    `, [vietNguyenId]);

    if (groupRes.rows.length > 0) {
      const dbGroupId = groupRes.rows[0].id;
      // Check if already in campaign_groups
      const checkRes = await client.query(`
        SELECT id FROM campaign_groups 
        WHERE campaign_id = $1 AND group_id = $2
      `, [campaignId, dbGroupId]);

      if (checkRes.rows.length === 0) {
        // Insert into campaign_groups
        const insertRes = await client.query(`
          INSERT INTO campaign_groups (campaign_id, group_id, assigned_nick_id, score, tier, status)
          VALUES ($1, $2, $3, 10, 'A', 'active')
          RETURNING id
        `, [campaignId, dbGroupId, vietNguyenId]);
        console.log(`Successfully added group to Tino campaign! Junction ID: ${insertRes.rows[0].id}`);
      } else {
        console.log('Group already assigned to this campaign.');
      }
    } else {
      console.warn('Group "OpenClaw AI Kiếm Cơm" not found in fb_groups for Việt Nguyễn.');
    }

    console.log('\n--- Roster Cleanup and Optimization Complete! ---');

  } catch (err) {
    console.error(err);
  } finally {
    await client.end();
  }
})();
