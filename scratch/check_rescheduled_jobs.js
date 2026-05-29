const { Client } = require('pg');
require('dotenv').config();

const client = new Client({
  connectionString: process.env.DATABASE_URL
});

(async () => {
  try {
    await client.connect();
    console.log('Connected to PostgreSQL Database on VPS');

    const res = await client.query(`
      SELECT id, type, payload->>'campaign_id' as campaign_id, status, scheduled_at, error_message
      FROM jobs 
      WHERE status = 'pending' AND payload->>'account_id' = 'aeb73391-53ed-409b-9dbe-181a8b2679fd'
      ORDER BY scheduled_at DESC 
      LIMIT 10
    `);

    console.log('\n--- Pending Jobs for Diệu Hiền ---');
    console.log(JSON.stringify(res.rows, null, 2));

  } catch (err) {
    console.error(err);
  } finally {
    await client.end();
  }
})();
