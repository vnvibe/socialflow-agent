const { Client } = require('pg');
require('dotenv').config();

const client = new Client({
  connectionString: process.env.DATABASE_URL
});

async function run() {
  await client.connect();
  console.log('Listing all accounts:');
  const res = await client.query("SELECT id, username, notes, is_active, status FROM accounts");
  console.log(res.rows);
  await client.end();
}

run().catch(console.error);
