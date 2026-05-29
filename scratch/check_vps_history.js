const { Client } = require('pg');
require('dotenv').config();

const client = new Client({
  connectionString: process.env.DATABASE_URL
});

(async () => {
  try {
    await client.connect();
    console.log('Connected to PostgreSQL Database on VPS');

    // Query heartbeats
    const hbRes = await client.query(`
      SELECT * 
      FROM agent_heartbeats 
      ORDER BY last_seen_at DESC
      LIMIT 5
    `);
    console.log('\n--- Recent Agent Heartbeats ---');
    for (const h of hbRes.rows) {
      console.log(`- Agent: ${h.agent_id} | Host: ${h.hostname} | Last Seen: ${h.last_seen_at} | Status: ${h.status}`);
    }

    // Query job_failures around 5:00 - 6:00 Indochina time
    const failRes = await client.query(`
      SELECT * 
      FROM job_failures 
      WHERE created_at BETWEEN '2026-05-28 22:00:00+00' AND '2026-05-28 23:00:00+00'
      ORDER BY created_at DESC
    `);
    console.log('\n--- Job Failures ---');
    if (failRes.rows.length === 0) {
      console.log('No job failures recorded.');
    } else {
      for (const f of failRes.rows) {
        console.log(`- Time: ${f.created_at} | Job: ${f.job_id} | Handler: ${f.handler_name} | Err: ${f.error_message}`);
      }
    }

  } catch (err) {
    console.error('Error running check:', err);
  } finally {
    await client.end();
  }
})();
