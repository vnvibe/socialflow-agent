const axios = require('axios');
require('dotenv').config();

(async () => {
  const url = 'https://103-142-24-60.sslip.io/agent-jobs/pending';
  const key = process.env.AGENT_SECRET || '6bee2416a8e3bc90b2346302e35c82bd9adaf790d7160eaa009d868e287afa1b';
  const userId = process.env.AGENT_USER_ID || '274868cf-742d-4d8a-89e8-bf1c37766b77';

  const fullUrl = `${url}?user_id=${userId}&slots=3`;
  console.log(`Fetching: ${fullUrl}`);
  console.log(`Using X-Agent-Key: ${key}`);

  try {
    const res = await axios.get(fullUrl, {
      timeout: 10000,
      headers: {
        'Accept': 'application/json',
        'X-Agent-Key': key
      }
    });
    console.log('Success! Status:', res.status);
    console.log('Pending Jobs Count:', res.data.length);
    console.log('Jobs Data:', JSON.stringify(res.data, null, 2));
  } catch (err) {
    console.log('Failed! Error code:', err.code);
    if (err.response) {
      console.log('HTTP Status:', err.response.status);
      console.log('Response Body:', err.response.data);
    } else {
      console.log('No HTTP response from server:', err.message);
    }
  }
})();
