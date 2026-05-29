const { Client } = require('pg');
require('dotenv').config();

const client = new Client({
  connectionString: process.env.DATABASE_URL
});

(async () => {
  await client.connect();
  console.log('Connected to PostgreSQL Database on VPS');

  // Let's test the WHERE conditions one by one for check_health jobs
  const res = await client.query(`
    SELECT id, status, scheduled_at, created_by, payload,
           (status = 'pending') as cond_status,
           (scheduled_at <= now()) as cond_sched,
           (created_by::text = '274868cf-742d-4d8a-89e8-bf1c37766b77' OR payload->>'owner_id' = '274868cf-742d-4d8a-89e8-bf1c37766b77') as cond_user
    FROM jobs 
    WHERE type = 'check_health'
    ORDER BY created_at DESC
    LIMIT 6
  `);
  
  console.log('\n--- check_health jobs WHERE conditions check ---');
  for (const r of res.rows) {
    console.log(`Job ID: ${r.id}`);
    console.log(`  Status: ${r.status} (cond_status: ${r.cond_status})`);
    console.log(`  Scheduled: ${r.scheduled_at} (cond_sched: ${r.cond_sched})`);
    console.log(`  Created By: ${r.created_by} (cond_user: ${r.cond_user})`);
    console.log(`  Payload: ${JSON.stringify(r.payload)}`);
    console.log(`  ------------------------------------------`);
  }

  await client.end();
})();
