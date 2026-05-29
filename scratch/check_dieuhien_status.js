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
      SELECT * 
      FROM accounts 
      WHERE id = 'aeb73391-53ed-409b-9dbe-181a8b2679fd'
    `);

    console.log('\n--- Account "Diệu Hiền" ---');
    console.log(JSON.stringify(res.rows, null, 2));

  } catch (err) {
    console.error(err);
  } finally {
    await client.end();
  }
})();
