const { Client } = require('pg');
require('dotenv').config();

const client = new Client({
  connectionString: process.env.DATABASE_URL
});

(async () => {
  await client.connect();
  console.log('Connected to PostgreSQL Database on VPS');

  // Let's dump column names of jobs to know what they are
  const jobsColumnsRes = await client.query(`
    SELECT column_name, data_type 
    FROM information_schema.columns 
    WHERE table_name = 'jobs'
  `);
  console.log('\n--- Columns in jobs ---');
  for (const col of jobsColumnsRes.rows) {
    console.log(`  - ${col.column_name} (${col.data_type})`);
  }

  await client.end();
})();
