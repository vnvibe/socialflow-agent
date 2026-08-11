const { Client } = require('pg');
require('dotenv').config();

const client = new Client({
  connectionString: process.env.DATABASE_URL
});

async function run() {
  await client.connect();

  console.log('--- Columns of jobs table ---');
  const res = await client.query(`
    SELECT column_name, data_type 
    FROM information_schema.columns 
    WHERE table_name = 'jobs'
  `);
  console.log(res.rows);

  await client.end();
}

run().catch(console.error);
