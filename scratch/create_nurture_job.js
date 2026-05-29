const { Client } = require('pg');
require('dotenv').config();

const client = new Client({
  connectionString: process.env.DATABASE_URL
});

(async () => {
  await client.connect();
  console.log('Connected to PostgreSQL Database on VPS');

  // Find Campaign Tino
  const campaignRes = await client.query("SELECT id, name, status, goal FROM campaigns WHERE name = 'Tino'");
  if (campaignRes.rows.length === 0) {
    console.error('Campaign Tino not found!');
    await client.end();
    return;
  }
  const tino = campaignRes.rows[0];

  // Find account Dieu Hien
  const accRes = await client.query("SELECT id, username FROM accounts WHERE id = 'aeb73391-53ed-409b-9dbe-181a8b2679fd'");
  if (accRes.rows.length === 0) {
    console.error('Account Dieu Hien not found!');
    await client.end();
    return;
  }
  const acc = accRes.rows[0];

  // Insert campaign_nurture job
  const payload = {
    account_id: acc.id,
    campaign_id: tino.id,
    role_id: 'nurture',
    topic: 'Treo tool OpenClaw trên VPS Windows tối ưu 24/7, tư vấn chọn VPS Windows cấu hình tốt nhất',
    force_now: true
  };

  const insertRes = await client.query(`
    INSERT INTO jobs (type, status, scheduled_at, priority, payload)
    VALUES ($1, $2, $3, $4, $5)
    RETURNING id
  `, ['campaign_nurture', 'pending', new Date().toISOString(), 1, JSON.stringify(payload)]);

  console.log(`\nCreated job successfully! Job ID: ${insertRes.rows[0].id}`);
  console.log(`Payload: ${JSON.stringify(payload, null, 2)}`);

  await client.end();
})();
