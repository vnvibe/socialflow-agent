const axios = require('axios');
require('dotenv').config();

(async () => {
  const url = 'https://103-142-24-60.sslip.io/ai-hermes/agent/status';
  const key = process.env.AGENT_SECRET || '6bee2416a8e3bc90b2346302e35c82bd9adaf790d7160eaa009d868e287afa1b';
  
  console.log(`Fetching: ${url}`);
  console.log(`Using X-Agent-Key: ${key}`);

  try {
    const res = await axios.get(url, {
      timeout: 10000,
      headers: {
        'Accept': 'application/json',
        'X-Agent-Key': key
      }
    });
    console.log('Success! Status:', res.status);
    console.log('Data:', res.data);
  } catch (err) {
    console.log('Failed! Error code:', err.code);
    if (err.response) {
      console.log('HTTP Status:', err.response.status);
      console.log('Response Headers:', err.response.headers);
      console.log('Response Body:', err.response.data);
    } else {
      console.log('No HTTP response from server:', err.message);
    }
  }
})();
