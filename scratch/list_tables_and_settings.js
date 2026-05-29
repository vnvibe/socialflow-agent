const { Client } = require('pg');
require('dotenv').config();

const client = new Client({
  connectionString: process.env.DATABASE_URL
});

(async () => {
  try {
    await client.connect();
    console.log('Connected to PostgreSQL Database on VPS');

    const tablesRes = await client.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public'
    `);
    const tables = tablesRes.rows.map(r => r.table_name);
    console.log('Tables in database:', tables);

    if (tables.includes('system_settings')) {
      const settingsRes = await client.query('SELECT key, length(value::text) as val_len FROM system_settings');
      console.log('\n--- System Settings Keys ---');
      for (const r of settingsRes.rows) {
        console.log(`Key: "${r.key}" (Value Length: ${r.val_len})`);
        // If it's related to hermes or model, print it
        if (r.key.includes('hermes') || r.key.includes('model') || r.key.includes('ai') || r.key.includes('api')) {
          const detail = await client.query('SELECT value FROM system_settings WHERE key = $1', [r.key]);
          console.log(`Value for ${r.key}:`, JSON.stringify(detail.rows[0].value, null, 2));
        }
      }
    }

  } catch (err) {
    console.error(err);
  } finally {
    await client.end();
  }
})();
