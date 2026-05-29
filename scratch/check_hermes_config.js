const { Client } = require('pg');
require('dotenv').config();

const client = new Client({
  connectionString: process.env.DATABASE_URL
});

(async () => {
  try {
    await client.connect();
    console.log('Connected to PostgreSQL Database on VPS');

    const configRes = await client.query('SELECT * FROM hermes_config LIMIT 5');
    console.log('\n--- Hermes Config ---');
    for (const row of configRes.rows) {
      console.log(JSON.stringify(row, null, 2));
    }

  } catch (err) {
    console.error('Error running check:', err);
  } finally {
    await client.end();
  }
})();
