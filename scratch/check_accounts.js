const { Client } = require('pg');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const dbUrl = process.env.DATABASE_URL;

(async () => {
  const client = new Client({ connectionString: dbUrl });
  try {
    await client.connect();
    
    console.log('--- Checking Accounts Info ---');
    const res = await client.query(`
      SELECT id, username, fb_user_id, status, is_active, proxy_id 
      FROM accounts 
      WHERE id IN ('7a8834a4-e8f3-42ab-8028-5d1b556df6e0', '391ccadd-c811-428f-ac03-eeba8b093ce9')
    `);
    console.log('Accounts:', JSON.stringify(res.rows, null, 2));

    const proxyIds = res.rows.map(r => r.proxy_id).filter(Boolean);
    if (proxyIds.length > 0) {
      console.log('\n--- Checking Proxies Info ---');
      const proxyRes = await client.query(`
        SELECT id, host, port, type, username, password 
        FROM proxies 
        WHERE id = ANY($1)
      `, [proxyIds]);
      console.log('Proxies:', JSON.stringify(proxyRes.rows, null, 2));
    } else {
      console.log('\nNo proxies configured for these accounts.');
    }

    await client.end();
  } catch (err) {
    console.error('Error querying DB:', err.message);
  }
})();
