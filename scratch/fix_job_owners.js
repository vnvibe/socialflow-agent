const { Client } = require('pg');
require('dotenv').config();

const client = new Client({
  connectionString: process.env.DATABASE_URL
});

(async () => {
  try {
    await client.connect();
    console.log('Connected to PostgreSQL Database on VPS');

    // 1. Update jobs where created_by is null using campaigns table owner_id
    const resCamp = await client.query(`
      UPDATE jobs j
      SET created_by = c.owner_id
      FROM campaigns c
      WHERE j.created_by IS NULL 
        AND j.payload->>'campaign_id' IS NOT NULL
        AND j.payload->>'campaign_id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        AND (j.payload->>'campaign_id')::uuid = c.id
      RETURNING j.id
    `);
    console.log(`Updated ${resCamp.rowCount} jobs' created_by using campaign owner_id.`);

    // 2. Update remaining jobs where created_by is null using accounts table owner_id
    const resAcc = await client.query(`
      UPDATE jobs j
      SET created_by = a.owner_id
      FROM accounts a
      WHERE j.created_by IS NULL 
        AND j.payload->>'account_id' IS NOT NULL
        AND j.payload->>'account_id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        AND (j.payload->>'account_id')::uuid = a.id
      RETURNING j.id
    `);
    console.log(`Updated ${resAcc.rowCount} jobs' created_by using account owner_id.`);

    // 3. Update the payload->>'owner_id' inside the json payload so it matches either way
    const resPayload = await client.query(`
      UPDATE jobs
      SET payload = jsonb_set(payload::jsonb, '{owner_id}', to_jsonb(created_by::text))
      WHERE created_by IS NOT NULL AND (payload->>'owner_id' IS NULL OR payload->>'owner_id' != created_by::text)
      RETURNING id
    `);
    console.log(`Injected owner_id into payload for ${resPayload.rowCount} jobs.`);

  } catch (err) {
    console.error(err);
  } finally {
    await client.end();
  }
})();
