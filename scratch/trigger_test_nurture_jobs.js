const { Client } = require('pg');
require('dotenv').config();

const client = new Client({
  connectionString: process.env.DATABASE_URL
});

(async () => {
  await client.connect();
  console.log('Connected to PostgreSQL Database on VPS');

  // List of healthy accounts to run campaign_nurture tests
  const accountsToTest = [
    { id: 'f946db84-b34d-48b7-9206-81b4c1b59d8a', name: 'Lorena Cezara' },
    { id: '2cdd5c69-6ba1-461a-8709-60644c64d4a0', name: 'Việt Nguyễn' },
    { id: '391ccadd-c811-428f-ac03-eeba8b093ce9', name: 'Dương Nguyễn' }
  ];

  // Find Campaign Tino
  const campaignRes = await client.query("SELECT id, name, status FROM campaigns WHERE name = 'Tino'");
  if (campaignRes.rows.length === 0) {
    console.error('Campaign Tino not found!');
    await client.end();
    return;
  }
  const tino = campaignRes.rows[0];

  console.log(`\nCreating campaign_nurture test jobs for Campaign "${tino.name}"...`);

  for (const acc of accountsToTest) {
    const payload = {
      account_id: acc.id,
      campaign_id: tino.id,
      role_id: 'nurture',
      topic: 'Treo tool OpenClaw trên VPS Windows tối ưu 24/7, tư vấn chọn VPS Windows cấu hình tốt nhất',
      force_now: true
    };

    const insertRes = await client.query(`
      INSERT INTO jobs (type, status, scheduled_at, priority, payload, created_by)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id
    `, ['campaign_nurture', 'pending', new Date().toISOString(), 1, JSON.stringify(payload), '274868cf-742d-4d8a-89e8-bf1c37766b77']);

    console.log(`- Created campaign_nurture test job for "${acc.name}" (ID: ${acc.id}) → Job ID: ${insertRes.rows[0].id}`);
  }

  console.log('\nAll campaign_nurture test jobs created successfully!');
  await client.end();
})();
