const { Client } = require('pg');
require('dotenv').config();

const client = new Client({
  connectionString: process.env.DATABASE_URL
});

async function run() {
  await client.connect();

  console.log('--- Columns of comment_logs ---');
  const resCol = await client.query(`
    SELECT column_name, data_type 
    FROM information_schema.columns 
    WHERE table_name = 'comment_logs'
  `);
  console.log(resCol.rows);

  console.log('--- Recent 10 comments in comment_logs ---');
  const resData = await client.query(`
    SELECT id, job_id, account_id, comment_text, status, error_message, created_at
    FROM comment_logs 
    ORDER BY created_at DESC 
    LIMIT 10
  `);
  console.log(resData.rows);

  await client.end();
}

run().catch(console.error);
