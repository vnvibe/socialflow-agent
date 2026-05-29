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
      SELECT id, type, payload->>'account_id' as acc_id, status, scheduled_at, started_at, finished_at, error_message, result
      FROM jobs 
      WHERE type = 'check_health'
      ORDER BY scheduled_at DESC 
      LIMIT 5
    `);

    console.log('\n--- Recent check_health Jobs ---');
    console.log(JSON.stringify(res.rows, null, 2));

  } catch (err) {
    console.error(err);
  } finally {
    await client.end();
  }
})();
