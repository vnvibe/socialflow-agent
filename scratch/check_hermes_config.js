const { Client } = require('pg');
require('dotenv').config();

const client = new Client({
  connectionString: process.env.DATABASE_URL
});

async function run() {
  await client.connect();

  console.log('--- Hermes Config ---');
  const res = await client.query(`
    SELECT * FROM hermes_config 
    LIMIT 10
  `);
  console.log(res.rows);

  await client.end();
}

run().catch(console.error);
