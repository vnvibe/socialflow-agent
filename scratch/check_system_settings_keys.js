const { Client } = require('pg');
require('dotenv').config();

const client = new Client({
  connectionString: process.env.DATABASE_URL
});

(async () => {
  try {
    await client.connect();
    console.log('Connected to PostgreSQL Database on VPS');

    const res = await client.query('SELECT key, updated_at FROM system_settings');
    console.log('\n--- System Settings Keys ---');
    for (const r of res.rows) {
      console.log(`Key: "${r.key}" (Updated: ${r.updated_at})`);
    }

  } catch (err) {
    console.error(err);
  } finally {
    await client.end();
  }
})();
