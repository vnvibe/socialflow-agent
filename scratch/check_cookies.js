const { Client } = require('pg');
require('dotenv').config();
const { parseCookieString } = require('../browser/launcher');

const client = new Client({
  connectionString: process.env.DATABASE_URL
});

(async () => {
  try {
    await client.connect();
    console.log('Connected to PostgreSQL Database on VPS');

    const res = await client.query('SELECT id, username, cookie_string, status, is_active FROM accounts');
    console.log(`\n--- Cookie Audit for ${res.rows.length} Accounts ---`);

    for (const a of res.rows) {
      console.log(`\nAccount: "${a.username}" (ID: ${a.id})`);
      console.log(`Status: ${a.status}, Active: ${a.is_active}`);
      
      const str = a.cookie_string;
      if (!str || str.trim() === '') {
        console.log('  ❌ NO COOKIE STRING');
        continue;
      }

      console.log(`  Raw Length: ${str.length} chars`);
      
      try {
        const parsed = parseCookieString(str);
        console.log(`  Parsed Cookies: ${parsed.length} items`);
        
        const cUser = parsed.find(c => c.name === 'c_user');
        const xs = parsed.find(c => c.name === 'xs');
        const datr = parsed.find(c => c.name === 'datr');
        const sb = parsed.find(c => c.name === 'sb');

        console.log(`  - c_user: ${cUser ? `FOUND (${cUser.value})` : '❌ MISSING'}`);
        console.log(`  - xs: ${xs ? `FOUND (${xs.value.slice(0, 10)}...)` : '❌ MISSING'}`);
        console.log(`  - datr: ${datr ? 'FOUND' : '❌ MISSING'}`);
        console.log(`  - sb: ${sb ? 'FOUND' : '❌ MISSING'}`);

        if (cUser && xs) {
          console.log('  ✅ COOKIE IS STRUCTURED CORRECTLY');
        } else {
          console.log('  ⚠️ COOKIE IS INCOMPLETE OR FAILED TO PARSE PROPERLY');
        }
      } catch (err) {
        console.error(`  ❌ PARSING ERROR: ${err.message}`);
      }
    }

  } catch (err) {
    console.error(err);
  } finally {
    await client.end();
  }
})();
