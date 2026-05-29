const { Client } = require('pg');
require('dotenv').config();

const client = new Client({
  connectionString: process.env.DATABASE_URL
});

(async () => {
  await client.connect();
  console.log('Connected to PostgreSQL Database on VPS');

  // Update created_by for all pending jobs to 274868cf-742d-4d8a-89e8-bf1c37766b77
  const updateRes = await client.query(`
    UPDATE jobs
    SET created_by = '274868cf-742d-4d8a-89e8-bf1c37766b77'
    WHERE status = 'pending'
  `);
  console.log(`Updated ${updateRes.rowCount} jobs' created_by to '274868cf-742d-4d8a-89e8-bf1c37766b77'`);

  await client.end();
})();
