const fs = require('fs');
const https = require('https');
const path = require('path');

const authPath = 'C:\\Users\\1phut\\AppData\\Roaming\\socialflow-agent\\auth.json';
if (!fs.existsSync(authPath)) {
  console.error('auth.json not found!');
  process.exit(1);
}

const auth = JSON.parse(fs.readFileSync(authPath, 'utf8'));
const token = auth.access_token || auth.token;

console.log('Using real active token:', token.slice(0, 30) + '...');

const url = 'https://103-142-24-60.sslip.io/campaigns/b41bee21-2d52-48ca-ba21-357d6dd5ee0c';
console.log(`Calling API: ${url}...`);

const req = https.get(url, {
  headers: {
    'Authorization': `Bearer ${token}`
  },
  rejectUnauthorized: false // Skip cert validation
}, (res) => {
  let body = '';
  res.on('data', chunk => body += chunk);
  res.on('end', () => {
    console.log(`Response Code: ${res.statusCode}`);
    try {
      const data = JSON.parse(body);
      console.log('\n--- Campaign from VPS API ---');
      console.log('ID:', data.id);
      console.log('Name:', data.name);
      console.log('Status:', data.status);
      console.log('Is Active:', data.is_active);
      console.log('Roles Count:', data.campaign_roles?.length || 0);
      console.log('Roles Detail:', JSON.stringify(data.campaign_roles, null, 2));
    } catch (e) {
      console.log('Response body:', body);
    }
  });
});

req.on('error', (err) => {
  console.error('Request Error:', err.message);
});
