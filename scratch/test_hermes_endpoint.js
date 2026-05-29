const axios = require('axios');

(async () => {
  const url = 'https://103-142-24-60.sslip.io/ai-hermes/status';
  console.log(`Fetching: ${url}`);
  try {
    const res = await axios.get(url, {
      timeout: 10000,
      headers: {
        'Accept': 'application/json'
      }
    });
    console.log('Success! Status:', res.status);
    console.log('Headers:', res.headers);
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

  // Let's also check /ai-hermes/config
  const urlConfig = 'https://103-142-24-60.sslip.io/ai-hermes/config';
  console.log(`\nFetching: ${urlConfig}`);
  try {
    const res = await axios.get(urlConfig, {
      timeout: 10000,
      headers: {
        'Accept': 'application/json',
        'X-Agent-Key': '961d2cc37be5f5a06e0c8f79d1f99e88017c46ab12048a0c0f7db6caee71cc86'
      }
    });
    console.log('Success! Status:', res.status);
    console.log('Data:', res.data);
  } catch (err) {
    console.log('Failed! Error code:', err.code);
    if (err.response) {
      console.log('HTTP Status:', err.response.status);
      console.log('Response Body:', err.response.data);
    }
  }
})();
