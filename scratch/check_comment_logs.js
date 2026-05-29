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
      SELECT 
        a.username as account_name, 
        c.source_name as group_name, 
        c.post_url, 
        c.comment_text, 
        c.created_at, 
        c.status,
        c.error_message
      FROM comment_logs c
      LEFT JOIN accounts a ON c.account_id = a.id
      ORDER BY c.created_at DESC 
      LIMIT 10
    `);

    console.log('\n--- Recent Comment Logs ---');
    console.log(JSON.stringify(res.rows, null, 2));

  } catch (err) {
    console.error(err);
  } finally {
    await client.end();
  }
})();
