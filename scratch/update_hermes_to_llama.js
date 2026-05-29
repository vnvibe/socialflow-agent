const { Client } = require('pg');
require('dotenv').config();

const client = new Client({
  connectionString: process.env.DATABASE_URL
});

(async () => {
  try {
    await client.connect();
    console.log('Connected to PostgreSQL Database on VPS');

    // 1. Fetch current config
    const fetchRes = await client.query('SELECT * FROM hermes_config WHERE id = 1');
    if (fetchRes.rows.length === 0) {
      console.log('No hermes_config row found!');
      return;
    }

    const row = fetchRes.rows[0];
    const currentConfig = row.config;
    console.log('Current Config:', JSON.stringify(currentConfig, null, 2));

    // 2. Modify config to use Llama 3.3
    const newConfig = {
      ...currentConfig,
      model: 'meta/llama-3.3-70b-instruct'
    };

    // 3. Update DB
    await client.query('UPDATE hermes_config SET config = $1 WHERE id = 1', [newConfig]);
    console.log('\nSuccessfully updated hermes_config to use meta/llama-3.3-70b-instruct!');

    // 4. Verify update
    const verifyRes = await client.query('SELECT * FROM hermes_config WHERE id = 1');
    console.log('Verified Config:', JSON.stringify(verifyRes.rows[0].config, null, 2));

  } catch (err) {
    console.error('Error updating hermes_config:', err.message);
  } finally {
    await client.end();
  }
})();
