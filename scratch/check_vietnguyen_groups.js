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
      SELECT id, fb_group_id, name, is_member, account_id
      FROM fb_groups 
      WHERE account_id = '2cdd5c69-6ba1-461a-8709-60644c64d4a0'
    `);

    console.log('\n--- All FB Groups joined by Việt Nguyễn ---');
    console.log(JSON.stringify(res.rows, null, 2));

  } catch (err) {
    console.error(err);
  } finally {
    await client.end();
  }
})();
