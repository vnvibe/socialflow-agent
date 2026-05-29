const { Client } = require('pg');
require('dotenv').config();

const client = new Client({
  connectionString: process.env.DATABASE_URL
});

(async () => {
  await client.connect();
  console.log('Connected to PostgreSQL Database on VPS');

  // Dump the created job
  const res = await client.query("SELECT * FROM jobs WHERE id = '6d675c25-cbe1-4191-8598-52c93ef25ee4'");
  console.log('\n--- The job we created ---');
  if (res.rows.length === 0) {
    console.log('Job NOT found!');
  } else {
    console.log(JSON.stringify(res.rows[0], null, 2));
  }

  // Check current date/time in Postgres to compare with scheduled_at
  const timeRes = await client.query("SELECT now(), now() AT TIME ZONE 'Asia/Ho_Chi_Minh' as local_time");
  console.log('\n--- Postgres server time ---');
  console.log(JSON.stringify(timeRes.rows[0], null, 2));

  await client.end();
})();
