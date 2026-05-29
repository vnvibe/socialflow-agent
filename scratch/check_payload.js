const { Client } = require('pg');
require('dotenv').config();

const client = new Client({
  connectionString: process.env.DATABASE_URL
});

(async () => {
  try {
    await client.connect();
    console.log('Connected to PostgreSQL Database on VPS');

    const res = await client.query("SELECT payload FROM jobs WHERE id = '8469aa6b-e4b6-4ed0-b485-154c8defc1d1'");
    console.log('\n--- Payload ---');
    console.log(JSON.stringify(res.rows[0]?.payload, null, 2));

  } catch (err) {
    console.error(err);
  } finally {
    await client.end();
  }
})();
