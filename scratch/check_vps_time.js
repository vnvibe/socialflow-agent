const { Client } = require('pg');
require('dotenv').config();

const client = new Client({
  connectionString: process.env.DATABASE_URL
});

(async () => {
  try {
    await client.connect();
    console.log('Connected to PostgreSQL Database on VPS');

    const res = await client.query('SELECT NOW() as db_now, CURRENT_TIMESTAMP as ts');
    console.log('\n--- VPS Database Time ---');
    console.log('DB Now:', res.rows[0].db_now);
    console.log('TS:', res.rows[0].ts);
    console.log('Local PC Now:', new Date().toISOString());

  } catch (err) {
    console.error(err);
  } finally {
    await client.end();
  }
})();
