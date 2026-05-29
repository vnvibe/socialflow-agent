const { Client } = require('pg');
require('dotenv').config();

const client = new Client({
  connectionString: process.env.DATABASE_URL
});

(async () => {
  try {
    await client.connect();
    console.log('Connected to PostgreSQL Database on VPS');

    const updateRes = await client.query(`
      UPDATE jobs 
      SET created_by = '274868cf-742d-4d8a-89e8-bf1c37766b77',
          payload = jsonb_set(COALESCE(payload::jsonb, '{}'::jsonb), '{owner_id}', '"274868cf-742d-4d8a-89e8-bf1c37766b77"')
      WHERE type = 'check_group_membership' AND (created_by IS NULL OR payload->>'owner_id' IS NULL)
    `);
    
    console.log(`Successfully updated ${updateRes.rowCount} jobs.`);

  } catch (err) {
    console.error('Error running update:', err);
  } finally {
    await client.end();
  }
})();
