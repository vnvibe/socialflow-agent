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
      SELECT id, name, is_active, status, ai_plan, ai_plan_confirmed 
      FROM campaigns 
      WHERE id = 'b41bee21-2d52-48ca-ba21-357d6dd5ee0c'
    `);

    console.log('\n--- Campaign Plan Details ---');
    console.log(JSON.stringify(res.rows, null, 2));

  } catch (err) {
    console.error(err);
  } finally {
    await client.end();
  }
})();
