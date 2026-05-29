const fs = require('fs');
const axios = require('axios');

const authPath = 'C:\\Users\\1phut\\AppData\\Roaming\\socialflow-agent\\auth.json';
if (!fs.existsSync(authPath)) {
  console.error('auth.json not found!');
  process.exit(1);
}

const auth = JSON.parse(fs.readFileSync(authPath, 'utf8'));
const token = auth.access_token || auth.token;

const API_URL = 'https://103-142-24-60.sslip.io';

(async () => {
  try {
    console.log('Fetching quality_gate skill prompt from VPS...');
    const res = await axios.get(`${API_URL}/ai-hermes/skills/quality_gate`, {
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });

    console.log('\n--- Quality Gate Prompt Content ---');
    console.log(res.data.content);

  } catch (err) {
    console.error('API Error:', err.response ? err.response.data : err.message);
  }
})();
