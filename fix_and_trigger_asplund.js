require('dotenv').config({ path: '/opt/socialflow/api/.env' });
const { Client } = require('pg');
const { executeRoleCampaign } = require('/opt/socialflow/api/src/services/campaign-scheduler');
const { db } = require('./lib/db');

const client = new Client({
  connectionString: process.env.DATABASE_URL
});

async function run() {
  await client.connect();
  
  // Step 1: Unblock the group for Asplund Bang Ky
  console.log('Unblocking group 852586990732832 for Asplund Bang Ky in fb_groups...');
  const res1 = await client.query(`
    UPDATE fb_groups 
    SET is_blocked = false 
    WHERE account_id = '7a8834a4-e8f3-42ab-8028-5d1b556df6e0'
      AND fb_group_id = '852586990732832'
  `);
  console.log(`Unblocked ${res1.rowCount} rows.`);

  console.log('Fetching campaign Tino VPS...');
  const { data: campaign, error } = await supabase
    .from('campaigns')
    .select('*, campaign_roles(*)')
    .eq('id', '4d164894-929a-483f-96d0-fa57d8a0464a')
    .single();

  if (error || !campaign) {
    console.error('Failed to fetch campaign:', error?.message || 'not found');
    await client.end();
    return;
  }

  console.log('Executing scheduler...');
  await executeRoleCampaign(campaign);

  // Step 3: Find the newly created job for Asplund Bang Ky and force it immediately
  console.log('Finding new pending job for Asplund Bang Ky...');
  const res2 = await client.query(`
    SELECT id FROM jobs 
    WHERE payload->>'account_id' = '7a8834a4-e8f3-42ab-8028-5d1b556df6e0'
      AND status = 'pending'
    ORDER BY created_at DESC
    LIMIT 1
  `);

  if (res2.rows.length > 0) {
    const jobId = res2.rows[0].id;
    console.log(`Found job ${jobId}. Updating to run immediately with force_now...`);
    await client.query(`
      UPDATE jobs 
      SET payload = jsonb_set(payload, '{force_now}', 'true'),
          scheduled_at = now() - interval '5 minutes'
      WHERE id = $1
    `, [jobId]);
    console.log('Job updated successfully!');
  } else {
    console.log('No new pending job found for Asplund Bang Ky.');
  }

  await client.end();
}

run().catch(console.error);
