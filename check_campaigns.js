const { Client } = require('pg');
require('dotenv').config();

const client = new Client({
  connectionString: process.env.DATABASE_URL
});

(async () => {
  await client.connect();
  console.log('Connected to PostgreSQL Database on VPS');

  // Let's dump column names of fb_groups
  const columnsRes = await client.query(`
    SELECT column_name, data_type 
    FROM information_schema.columns 
    WHERE table_name = 'fb_groups'
  `);
  console.log('\n--- Columns in fb_groups ---');
  for (const col of columnsRes.rows) {
    console.log(`  - ${col.column_name} (${col.data_type})`);
  }

  // Let's dump column names of campaign_groups
  const cgColumnsRes = await client.query(`
    SELECT column_name, data_type 
    FROM information_schema.columns 
    WHERE table_name = 'campaign_groups'
  `);
  console.log('\n--- Columns in campaign_groups ---');
  for (const col of cgColumnsRes.rows) {
    console.log(`  - ${col.column_name} (${col.data_type})`);
  }

  // Query campaigns
  const campaignsRes = await client.query('SELECT id, name, status, goal FROM campaigns');
  console.log('\n--- Active Campaigns ---');
  for (const c of campaignsRes.rows) {
    console.log(`\nCampaign: ${c.name} (${c.status})`);
  }

  await client.end();
})();
