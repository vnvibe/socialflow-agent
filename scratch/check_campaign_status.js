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
      SELECT id, name, is_active, status, kpi_config 
      FROM campaigns 
      WHERE id = 'aded1474-d82c-47d9-90e4-7720f798b791'
    `);

    console.log('\n--- Campaign Status for Openclaw vps ---');
    for (const r of res.rows) {
      console.log(JSON.stringify(r, null, 2));
    }

  } catch (err) {
    console.error('Error running check:', err);
  } finally {
    await client.end();
  }
})();
