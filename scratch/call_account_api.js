const fs = require('fs');
const https = require('https');

const authPath = 'C:\\Users\\1phut\\AppData\\Roaming\\socialflow-agent\\auth.json';
if (!fs.existsSync(authPath)) {
  console.error('auth.json not found!');
  process.exit(1);
}

const auth = JSON.parse(fs.readFileSync(authPath, 'utf8'));
const token = auth.access_token || auth.token;

const url = 'https://103-142-24-60.sslip.io/accounts/2cdd5c69-6ba1-461a-8709-60644c64d4a0';
console.log(`Calling API: ${url}...`);

const req = https.get(url, {
  headers: {
    'Authorization': `Bearer ${token}`
  },
  rejectUnauthorized: false
}, (res) => {
  let body = '';
  res.on('data', chunk => body += chunk);
  res.on('end', () => {
    console.log(`Response Code: ${res.statusCode}`);
    try {
      const data = JSON.parse(body);
      console.log('\n--- Account from VPS API ---');
      console.log('ID:', data.id);
      console.log('Username:', data.username);
      console.log('Status:', data.status);
      console.log('Is Active:', data.is_active);
      console.log('Last Error:', data.last_error);
    } catch (e) {
      console.log('Response body:', body);
    }
  });
});

req.on('error', (err) => {
  console.error('Request Error:', err.message);
});
