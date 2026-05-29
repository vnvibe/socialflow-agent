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
      SELECT id, account_id, source_name, comment_text, created_at, status, error_message
      FROM comment_logs 
      WHERE created_at >= '2026-05-25 00:00:00'
      ORDER BY created_at DESC
    `);

    console.log('\n--- Comments since May 25 ---');
    console.log(JSON.stringify(res.rows, null, 2));

  } catch (err) {
    console.error(err);
  } finally {
    await client.end();
  }
})();
