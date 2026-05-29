const { Client } = require('pg');
require('dotenv').config();

const client = new Client({
  connectionString: process.env.DATABASE_URL
});

(async () => {
  try {
    await client.connect();
    console.log('Connected to PostgreSQL Database on VPS');

    const jobsRes = await client.query(`
      SELECT id, type, status, created_by, payload->>'owner_id' AS owner_id, scheduled_at 
      FROM jobs 
      WHERE status = 'pending'
      ORDER BY created_at DESC
    `);
    console.log('\n--- Pending Jobs Details ---');
    for (const j of jobsRes.rows) {
      console.log(`- Job ID: ${j.id} | Type: ${j.type} | created_by: ${j.created_by} | owner_id: ${j.owner_id} | Scheduled: ${j.scheduled_at}`);
    }

  } catch (err) {
    console.error('Error running check:', err);
  } finally {
    await client.end();
  }
})();
