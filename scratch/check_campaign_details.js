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

    const rolesRes = await client.query('SELECT * FROM campaign_roles WHERE campaign_id = $1', [campaignId]);
    console.log('\n--- Campaign Roles ---');
    console.log(JSON.stringify(rolesRes.rows, null, 2));

    const groupsRes = await client.query('SELECT * FROM campaign_groups WHERE campaign_id = $1', [campaignId]);
    console.log('\n--- Campaign Groups ---');
    console.log(JSON.stringify(groupsRes.rows, null, 2));

  } catch (err) {
    console.error(err);
  } finally {
    await client.end();
  }
})();
