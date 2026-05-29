const { Client } = require('pg');
require('dotenv').config();

const client = new Client({
  connectionString: process.env.DATABASE_URL
});

(async () => {
  try {
    await client.connect();
    console.log('Connected to PostgreSQL Database on VPS');

    // List all tables
    const tablesRes = await client.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public'
    `);
    console.log('\n--- Tables in public schema ---');
    for (const t of tablesRes.rows) {
      console.log(`  - ${t.table_name}`);
    }

  } catch (err) {
    console.error('Error running check:', err);
  } finally {
    await client.end();
  }
})();
