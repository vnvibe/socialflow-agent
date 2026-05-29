const { Client } = require('pg');
require('dotenv').config();

const client = new Client({
  connectionString: process.env.DATABASE_URL
});

(async () => {
  try {
    await client.connect();
    console.log('Connected to PostgreSQL Database on VPS');

    const accountId = 'aeb73391-53ed-409b-9dbe-181a8b2679fd'; // Diệu Hiền

    console.log('\nRescheduling jobs for Diệu Hiền to run immediately...');

    // Reschedule campaign_nurture
    const resNurture = await client.query(`
      UPDATE jobs
      SET status = 'pending',
          scheduled_at = $1,
          priority = 1,
          started_at = NULL,
          finished_at = NULL,
          attempt = 0,
          error_message = NULL
      WHERE type = 'campaign_nurture' AND payload->>'account_id' = $2
      RETURNING id
    `, [new Date().toISOString(), accountId]);

    console.log(`Rescheduled ${resNurture.rowCount} campaign_nurture job(s).`);

    // Reschedule nurture_feed
    const resFeed = await client.query(`
      UPDATE jobs
      SET status = 'pending',
          scheduled_at = $1,
          priority = 1,
          started_at = NULL,
          finished_at = NULL,
          attempt = 0,
          error_message = NULL
      WHERE type = 'nurture_feed' AND payload->>'account_id' = $2
      RETURNING id
    `, [new Date().toISOString(), accountId]);

    console.log(`Rescheduled ${resFeed.rowCount} nurture_feed job(s).`);

    // Let's also verify that other accounts' pending jobs are cancelled or ignored
    const resCancel = await client.query(`
      UPDATE jobs
      SET status = 'cancelled',
          error_message = 'account_not_active'
      WHERE status = 'pending' AND payload->>'account_id' != $1
    `, [accountId]);
    console.log(`Cancelled ${resCancel.rowCount} pending jobs belonging to other inactive accounts to clear the queue.`);

    console.log('\nRescheduling completed successfully!');

  } catch (err) {
    console.error(err);
  } finally {
    await client.end();
  }
})();
