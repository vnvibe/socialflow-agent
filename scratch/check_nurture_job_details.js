const { Client } = require('pg');
require('dotenv').config();

const client = new Client({
  connectionString: 'postgresql://socialflow:sf_secure_2026_rot_4821a@103.142.24.60:5432/socialflow'
});

(async () => {
  try {
    await client.connect();
    console.log('Connected to PostgreSQL Database on VPS');

    const todayStr = new Date().toISOString().split('T')[0];

    const jobsRes = await client.query(`
      SELECT id, type, status, payload, error_message, created_at, finished_at 
      FROM jobs 
      WHERE type = 'campaign_nurture' AND created_at >= $1::date
      ORDER BY created_at DESC
      LIMIT 5
    `, [todayStr]);

    console.log('\n--- Recent Campaign Nurture Jobs Payloads ---');
    for (const j of jobsRes.rows) {
      console.log(`\n- Job ID: ${j.id}`);
      console.log(`  Status: ${j.status}`);
      console.log(`  Created: ${j.created_at}`);
      console.log(`  Finished: ${j.finished_at}`);
      console.log(`  Error: ${j.error_message}`);
      console.log(`  Payload:`, JSON.stringify(j.payload, null, 2));
    }

  } catch (err) {
    console.error('Error running check:', err);
  } finally {
    await client.end();
  }
})();
