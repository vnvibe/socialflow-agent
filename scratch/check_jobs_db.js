const { Client } = require('pg');
require('dotenv').config();

const client = new Client({
  connectionString: process.env.DATABASE_URL
});

(async () => {
  try {
    await client.connect();
    console.log('Connected to PostgreSQL Database on VPS');

    // 1. Fetch Accounts
    const accountsRes = await client.query('SELECT id, username, status FROM accounts');
    console.log('\n--- Accounts ---');
    for (const a of accountsRes.rows) {
      console.log(`- ID: ${a.id} | Username: ${a.username} | Status: ${a.status}`);
    }

    // 2. Fetch Campaigns
    const campaignsRes = await client.query('SELECT id, name, status, goal FROM campaigns');
    console.log('\n--- Campaigns ---');
    for (const c of campaignsRes.rows) {
      console.log(`- ID: ${c.id} | Name: ${c.name} | Status: ${c.status} | Goal: ${c.goal}`);
    }

    // 3. Fetch Pending/Running Jobs
    const jobsRes = await client.query(`
      SELECT id, type, status, payload, created_at, scheduled_at 
      FROM jobs 
      WHERE status IN ('pending', 'running')
      ORDER BY created_at DESC
      LIMIT 10
    `);
    console.log('\n--- Pending/Running Jobs ---');
    if (jobsRes.rows.length === 0) {
      console.log('No pending or running jobs.');
    } else {
      for (const j of jobsRes.rows) {
        console.log(`- Job ID: ${j.id} | Type: ${j.type} | Status: ${j.status} | Created: ${j.created_at} | Scheduled: ${j.scheduled_at} | Payload: ${JSON.stringify(j.payload)}`);
      }
    }

    // 4. Check Completed/Failed Jobs in the last 2 hours
    const recentJobsRes = await client.query(`
      SELECT id, type, status, error_message, finished_at 
      FROM jobs 
      WHERE finished_at >= NOW() - INTERVAL '2 hours'
      ORDER BY finished_at DESC
      LIMIT 10
    `);
    console.log('\n--- Recent Jobs (Last 2 Hours) ---');
    if (recentJobsRes.rows.length === 0) {
      console.log('No recent jobs in last 2 hours.');
    } else {
      for (const j of recentJobsRes.rows) {
        console.log(`- Job ID: ${j.id} | Type: ${j.type} | Status: ${j.status} | Finished: ${j.finished_at} | Err: ${j.error_message || 'none'}`);
      }
    }

  } catch (err) {
    console.error('Error running check:', err);
  } finally {
    await client.end();
  }
})();
