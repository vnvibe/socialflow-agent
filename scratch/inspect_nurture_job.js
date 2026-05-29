const { Client } = require('pg');
require('dotenv').config();

const client = new Client({
  connectionString: process.env.DATABASE_URL
});

(async () => {
  try {
    await client.connect();
    console.log('Connected to PostgreSQL Database on VPS');

    const activityRes = await client.query(`
      SELECT * 
      FROM campaign_activity_log 
      WHERE job_id = '66c4ac02-84a6-4746-beae-67536c028332'
      ORDER BY created_at ASC
    `);

    console.log('\n--- Campaign Activity Logs for Job ---');
    for (const log of activityRes.rows) {
      console.log(`[${log.action_type || log.type}] ${JSON.stringify(log.details || log)}`);
    }

  } catch (err) {
    console.error('Error running query:', err);
  } finally {
    await client.end();
  }
})();
