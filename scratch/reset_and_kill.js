const { Client } = require('pg');
const { execSync } = require('child_process');
require('dotenv').config();

const client = new Client({
  connectionString: process.env.DATABASE_URL
});

(async () => {
  await client.connect();
  console.log('Connected to PostgreSQL Database on VPS');

  // Cancel the stuck job
  const cancelRes = await client.query(`
    UPDATE jobs
    SET status = 'cancelled', error_message = 'stuck_reset'
    WHERE id = '6d675c25-cbe1-4191-8598-52c93ef25ee4' AND status = 'running'
  `);
  console.log(`Cancelled ${cancelRes.rowCount} stuck job.`);

  // Ensure account Dieu Hien is active and healthy
  const accRes = await client.query(`
    UPDATE accounts
    SET is_active = true, status = 'healthy', last_error = null
    WHERE id = 'aeb73391-53ed-409b-9dbe-181a8b2679fd'
  `);
  console.log(`Updated account Dieu Hien status to healthy.`);

  // Kill chromium processes on local Windows
  try {
    console.log('Killing all chrome.exe processes...');
    execSync('taskkill /F /IM chrome.exe', { stdio: 'ignore' });
    console.log('Killed chrome processes successfully.');
  } catch (e) {
    console.log('No chrome processes found or could not kill them.');
  }

  // Clear profiles lock files
  try {
    const fs = require('fs');
    const path = require('path');
    const os = require('os');
    const lockFiles = ['SingletonLock', 'SingletonCookie', 'SingletonSocket'];
    const profileDir = path.join(os.homedir(), '.socialflow', 'profiles', 'aeb73391-53ed-409b-9dbe-181a8b2679fd', 'browser-data');
    if (fs.existsSync(profileDir)) {
      for (const lf of lockFiles) {
        const fp = path.join(profileDir, lf);
        if (fs.existsSync(fp)) {
          fs.unlinkSync(fp);
          console.log(`Cleared lock file: ${lf}`);
        }
      }
    }
  } catch (err) {
    console.warn('Failed to clear profile lock files:', err.message);
  }

  // Create a new fresh job
  const payload = {
    account_id: 'aeb73391-53ed-409b-9dbe-181a8b2679fd',
    campaign_id: 'b41bee21-2d52-48ca-ba21-357d6dd5ee0c',
    role_id: 'nurture',
    topic: 'Treo tool OpenClaw trên VPS Windows tối ưu 24/7, tư vấn chọn VPS Windows cấu hình tốt nhất',
    force_now: true
  };

  const insertRes = await client.query(`
    INSERT INTO jobs (type, status, scheduled_at, priority, payload, created_by)
    VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING id
  `, ['campaign_nurture', 'pending', new Date().toISOString(), 1, JSON.stringify(payload), '274868cf-742d-4d8a-89e8-bf1c37766b77']);

  console.log(`Created new job! Job ID: ${insertRes.rows[0].id}`);

  await client.end();
})();
