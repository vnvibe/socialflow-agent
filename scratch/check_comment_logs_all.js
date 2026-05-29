const { Client } = require('pg');
require('dotenv').config();

const client = new Client({
  connectionString: process.env.DATABASE_URL
});

(async () => {
  try {
    await client.connect();
    console.log('Connected to PostgreSQL Database on VPS');

    const countRes = await client.query('SELECT count(*) FROM comment_logs');
    console.log('Total rows in comment_logs:', countRes.rows[0].count);

    const latestRes = await client.query(`
      SELECT c.id, a.username, c.source_name, c.comment_text, c.created_at, c.status, c.error_message
      FROM comment_logs c
      LEFT JOIN accounts a ON c.account_id = a.id
      ORDER BY c.created_at DESC 
      LIMIT 20
    `);

    console.log('\n--- Latest 20 Rows ---');
    console.log(JSON.stringify(latestRes.rows, null, 2));

  } catch (err) {
    console.error(err);
  } finally {
    await client.end();
  }
})();
