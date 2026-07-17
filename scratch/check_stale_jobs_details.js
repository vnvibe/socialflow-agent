const { Client } = require('pg');
require('dotenv').config();

const client = new Client({
  connectionString: process.env.DATABASE_URL
});

async function run() {
  await client.connect();

  console.log('--- Fetching owner details of reaped account jobs ---');
  const res = await client.query(`
    SELECT DISTINCT a.username, a.owner_id, a.id as account_id
    FROM accounts a
    WHERE a.username IN ('Dương Nguyễn', 'Dinh Thi Dinh', 'Diệu Hiền')
  `);
  console.log(res.rows);

  await client.end();
}

run().catch(console.error);
