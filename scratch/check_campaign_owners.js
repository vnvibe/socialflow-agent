const { Client } = require('pg');
require('dotenv').config();

const client = new Client({
  connectionString: process.env.DATABASE_URL
});

(async () => {
  try {
    await client.connect();
    console.log('Connected to PostgreSQL Database on VPS');

    const res = await client.query('SELECT id, name, owner_id, status, is_active FROM campaigns WHERE name = \'Tino\'');
    console.log('\n--- Tino Campaign in DB ---');
    console.log(JSON.stringify(res.rows, null, 2));

    // Also check profiles or users table to see what users exist
    const usersRes = await client.query('SELECT id, email FROM profiles LIMIT 5');
    console.log('\n--- Profiles in DB ---');
    console.log(JSON.stringify(usersRes.rows, null, 2));

  } catch (err) {
    console.error(err);
  } finally {
    await client.end();
  }
})();
