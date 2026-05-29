const { Client } = require('pg');
require('dotenv').config();

const client = new Client({
  connectionString: process.env.DATABASE_URL
});

(async () => {
  try {
    await client.connect();
    console.log('Connected to PostgreSQL Database on VPS');

    // 1. Query all accounts in DB
    const accsRes = await client.query(`
      SELECT id, username, status, is_active, cookie_string, last_checked_at
      FROM accounts
    `);

    const accounts = accsRes.rows;
    console.log(`\nFound ${accounts.length} accounts in database.`);

    // Filter accounts with valid cookies
    const accountsWithCookies = accounts.filter(a => a.cookie_string && a.cookie_string.trim().length > 0);
    console.log(`Accounts with cookie string: ${accountsWithCookies.length}`);

    if (accountsWithCookies.length === 0) {
      console.log('No accounts with cookies found! Exiting.');
      await client.end();
      return;
    }

    // 2. Clear existing pending/running health checks to avoid duplication
    const clearRes = await client.query(`
      DELETE FROM jobs
      WHERE type = 'check_health' AND status IN ('pending', 'running')
    `);
    console.log(`Cleared ${clearRes.rowCount} stale pending/running check_health jobs.`);

    // 3. Trigger check_health job for each account
    console.log('\n--- Triggering Health Check Jobs ---');
    const agentUserId = process.env.AGENT_USER_ID || '274868cf-742d-4d8a-89e8-bf1c37766b77';

    for (const acc of accountsWithCookies) {
      const payload = {
        account_id: acc.id,
        force_now: true
      };

      const insertRes = await client.query(`
        INSERT INTO jobs (type, status, scheduled_at, priority, payload, created_by)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING id
      `, [
        'check_health',
        'pending',
        new Date().toISOString(),
        1, // high priority
        JSON.stringify(payload),
        agentUserId
      ]);

      console.log(`- Created check_health job for "${acc.username}" (Active: ${acc.is_active}, Current Status: ${acc.status})`);
      console.log(`  Job ID: ${insertRes.rows[0].id}`);
    }

    console.log('\nAll health check audit jobs have been queued successfully!');
    console.log('The active agent will now pick them up and run them one by one.');

  } catch (err) {
    console.error('Error during triggering:', err);
  } finally {
    await client.end();
  }
})();
