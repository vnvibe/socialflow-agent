const { Client } = require('pg');
require('dotenv').config();

const client = new Client({
  connectionString: process.env.DATABASE_URL
});

(async () => {
  try {
    await client.connect();
    console.log('Connected to PostgreSQL Database on VPS');

    // Query hermes_config table columns and rows
    const res = await client.query('SELECT * FROM hermes_config');
    console.log('\n--- hermes_config rows ---');
    console.log(JSON.stringify(res.rows, null, 2));

  } catch (err) {
    console.error('Error querying hermes_config:', err.message);
  } finally {
    await client.end();
  }
})();
