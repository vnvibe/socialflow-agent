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
    const payload = {
      post_snippet: 'Học lập trình Web thì nên bắt đầu từ đâu các bác? Em đang tự học HTML CSS JS nhưng mông lung quá, có lộ trình nào chuẩn không ạ?',
      group_name: 'Học Lập Trình Web',
      topic: 'Lập trình web',
      style: 'casual',
      language: 'vi',
      campaign_id: 'b41bee21-2d52-48ca-ba21-357d6dd5ee0c'
    };

    console.log('Sending request to /ai-hermes/comment...');
    const res = await axios.post(`${API_URL}/ai-hermes/comment`, payload, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      }
    });

    console.log('Response status:', res.status);
    console.log('Response data:', JSON.stringify(res.data, null, 2));

  } catch (err) {
    console.error('API Error:', err.response ? {
      status: err.response.status,
      data: err.response.data
    } : err.message);
  }
})();
