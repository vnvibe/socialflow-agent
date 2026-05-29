const { Client } = require('pg');
require('dotenv').config();

const client = new Client({
  connectionString: process.env.DATABASE_URL
});

(async () => {
  try {
    await client.connect();
    console.log('Connected to PostgreSQL Database on VPS');

    const hermesConfig = await client.query('SELECT * FROM hermes_config');
    console.log('\n--- hermes_config Rows ---');
    console.log(JSON.stringify(hermesConfig.rows, null, 2));

    const aiSettings = await client.query('SELECT * FROM ai_settings');
    console.log('\n--- ai_settings Rows ---');
    console.log(JSON.stringify(aiSettings.rows, null, 2));

  } catch (err) {
    console.error(err);
  } finally {
    await client.end();
  }
})();
