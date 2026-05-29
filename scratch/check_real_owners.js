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
      SELECT id, type, created_by, payload->>'owner_id' as owner_id, status, scheduled_at 
      FROM jobs 
      WHERE status = 'pending' AND payload->>'account_id' = 'aeb73391-53ed-409b-9dbe-181a8b2679fd'
      LIMIT 5
    `);

    console.log('\n--- Real Pending Job Details ---');
    console.log(JSON.stringify(res.rows, null, 2));

  } catch (err) {
    console.error(err);
  } finally {
    await client.end();
  }
})();
