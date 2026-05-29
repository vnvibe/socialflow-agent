const { Client } = require('pg');
require('dotenv').config();

const client = new Client({
  connectionString: process.env.DATABASE_URL
});

(async () => {
  await client.connect();
  console.log('Connected to PostgreSQL Database on VPS');

  // List of accounts to trigger health check
  const accountsToAudit = [
    { id: 'f946db84-b34d-48b7-9206-81b4c1b59d8a', name: 'Lorena Cezara' },
    { id: '2cdd5c69-6ba1-461a-8709-60644c64d4a0', name: 'Việt Nguyễn' },
    { id: '391ccadd-c811-428f-ac03-eeba8b093ce9', name: 'Dương Nguyễn' },
    { id: '349b0998-e193-4be6-8c7b-584d33c4d1d8', name: 'Thúy Thùy' },
    { id: 'a70814a5-94ba-47ef-ab4d-ae5fd9e08fbf', name: 'Chau Hien Phuc' },
    { id: '6010461b-97fc-40ce-b407-8cddf18d40e1', name: 'Do Hoang Nam' }
  ];

  console.log('\nCreating check_health jobs for auditing...');

  for (const acc of accountsToAudit) {
    // We will update the accounts status to pending check, and make sure their is_active check is bypassed
    // by the check_health job.
    const payload = {
      account_id: acc.id,
      force_now: true
    };

    const insertRes = await client.query(`
      INSERT INTO jobs (type, status, scheduled_at, priority, payload, created_by)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id
    `, ['check_health', 'pending', new Date().toISOString(), 1, JSON.stringify(payload), '274868cf-742d-4d8a-89e8-bf1c37766b77']);

    console.log(`- Created check_health job for "${acc.name}" (ID: ${acc.id}) → Job ID: ${insertRes.rows[0].id}`);
  }

  console.log('\nAll health check audit jobs created successfully!');
  await client.end();
})();
