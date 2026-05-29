const { Client } = require('pg');
require('dotenv').config();

const client = new Client({
  connectionString: process.env.DATABASE_URL
});

(async () => {
  await client.connect();
  console.log('Connected to PostgreSQL Database on VPS');

  // Let's dump column names of comment_logs to know what they are
  const colsRes = await client.query(`
    SELECT column_name, data_type 
    FROM information_schema.columns 
    WHERE table_name = 'comment_logs'
  `);
  console.log('\n--- Columns in comment_logs ---');
  for (const col of colsRes.rows) {
    console.log(`  - ${col.column_name} (${col.data_type})`);
  }

  await client.end();
})();
