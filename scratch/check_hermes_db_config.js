const { Client } = require('pg');
require('dotenv').config();

const client = new Client({
  connectionString: process.env.DATABASE_URL
});

(async () => {
  try {
    await client.connect();
    console.log('Connected to PostgreSQL Database on VPS');

    // 1. Check all tables related to hermes or settings
    const tablesRes = await client.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public'
    `);
    const tables = tablesRes.rows.map(r => r.table_name);
    console.log('Tables in database:', tables);

    // 2. Query system_settings
    if (tables.includes('system_settings')) {
      const settingsRes = await client.query('SELECT * FROM system_settings');
      console.log('\n--- System Settings ---');
      for (const r of settingsRes.rows) {
        console.log(`Key: "${r.key}"`);
        console.log(`Value:`, JSON.stringify(r.value, null, 2));
        console.log('------------------------------------------');
      }
    }

    // 3. Query hermes_config or similar
    const hermesTables = tables.filter(t => t.includes('hermes') || t.includes('ai') || t.includes('config'));
    console.log('\nHermes/AI/Config Tables:', hermesTables);

    for (const t of hermesTables) {
      if (t === 'system_settings') continue;
      try {
        const res = await client.query(`SELECT * FROM ${t} LIMIT 5`);
        console.log(`\n--- Data from Table: ${t} ---`);
        console.log(JSON.stringify(res.rows, null, 2));
      } catch (err) {
        console.log(`Could not query table ${t}: ${err.message}`);
      }
    }

  } catch (err) {
    console.error(err);
  } finally {
    await client.end();
  }
})();
