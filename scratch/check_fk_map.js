const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

(async () => {
  const { rows } = await pool.query(`
    SELECT tc.table_name, kcu.column_name, ccu.table_name as ref_table, ccu.column_name as ref_col
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
    JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
    WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'
  `);

  console.log('\n--- FK Rows from Postgres ---');
  for (const r of rows) {
    if (r.table_name === 'campaign_groups' || r.ref_table === 'campaign_groups') {
      console.log(JSON.stringify(r));
    }
  }

  pool.end();
})();
