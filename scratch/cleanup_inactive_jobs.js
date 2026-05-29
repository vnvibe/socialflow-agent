const { Client } = require('pg');
require('dotenv').config();

const client = new Client({
  connectionString: process.env.DATABASE_URL
});

(async () => {
  try {
    await client.connect();
    console.log('Connected to PostgreSQL Database on VPS');

    const dhId = 'aeb73391-53ed-409b-9dbe-181a8b2679fd'; // Diệu Hiền

    // 1. Get Campaign Tino ID
    const cRes = await client.query("SELECT id, name FROM campaigns WHERE name = 'Tino'");
    if (cRes.rows.length === 0) {
      console.error('Campaign Tino not found!');
      await client.end();
      return;
    }
    const tinoId = cRes.rows[0].id;
    console.log(`Campaign Tino ID: ${tinoId}`);

    // 2. Cancel/Delete all pending campaign_nurture jobs for Diệu Hiền where campaign_id is not Tino's
    const deleteRes = await client.query(`
      DELETE FROM jobs
      WHERE type = 'campaign_nurture' 
        AND payload->>'account_id' = $1 
        AND (payload->>'campaign_id' != $2 OR payload->>'campaign_id' IS NULL)
        AND status = 'pending'
    `, [dhId, tinoId]);

    console.log(`Deleted ${deleteRes.rowCount} pending campaign_nurture jobs belonging to paused campaigns.`);

    // 3. Make sure the Tino campaign job is pending and scheduled for NOW
    const rescheduleRes = await client.query(`
      UPDATE jobs
      SET status = 'pending',
          scheduled_at = $1,
          priority = 1,
          started_at = NULL,
          finished_at = NULL,
          attempt = 0,
          error_message = NULL
      WHERE type = 'campaign_nurture' 
        AND payload->>'account_id' = $2 
        AND payload->>'campaign_id' = $3
    `, [new Date().toISOString(), dhId, tinoId]);

    console.log(`Ensured ${rescheduleRes.rowCount} Tino campaign jobs are pending and scheduled to run NOW.`);

  } catch (err) {
    console.error(err);
  } finally {
    await client.end();
  }
})();
