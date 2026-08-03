require('dotenv').config();
const { Client } = require('pg');
const { db } = require('../lib/db');
const joinGroupHandler = require('../jobs/handlers/join-group');

const client = new Client({
  connectionString: process.env.DATABASE_URL
});

async function runTest() {
  await client.connect();
  console.log('Fetching pending join_group job for campaign Tino VPS...');
  
  const res = await client.query(`
    SELECT id, payload 
    FROM jobs 
    WHERE type = 'join_group' AND status = 'pending'
    ORDER BY created_at DESC
    LIMIT 1
  `);

  if (res.rows.length === 0) {
    console.log('No pending join_group jobs found.');
    await client.end();
    return;
  }

  const job = res.rows[0];
  console.log(`Testing job ID: ${job.id}`);
  console.log('Payload:', job.payload);

  await client.end();

  try {
    const result = await joinGroupHandler(job.payload, supabase);
    console.log('\n[JOIN-TEST RESULT]:', result);
  } catch (err) {
    console.error('\n[JOIN-TEST ERROR]:', err.message);
  }
}

runTest().catch(console.error);
