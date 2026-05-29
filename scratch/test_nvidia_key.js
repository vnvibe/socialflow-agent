const axios = require('axios');

(async () => {
  const url = 'https://integrate.api.nvidia.com/v1/chat/completions';
  const apiKey = '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';
  const model = 'minimaxai/minimax-m2.7';

  console.log(`Sending test request to Nvidia NIM: ${url}`);
  console.log(`Using model: ${model}`);

  try {
    const res = await axios.post(url, {
      model: model,
      messages: [{ role: 'user', content: 'Xin chào, bạn có hoạt động không? Trả lời thật ngắn gọn.' }],
      temperature: 0.1,
      max_tokens: 50
    }, {
      timeout: 15000,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      }
    });

    console.log('\nNvidia NIM Status: WORKING!');
    console.log('Response Status:', res.status);
    console.log('Response Text:', res.data.choices[0].message.content);

  } catch (err) {
    console.log('\nNvidia NIM Status: FAILED!');
    if (err.response) {
      console.log('HTTP Status:', err.response.status);
      console.log('Response Headers:', err.response.headers);
      console.log('Response Body:', err.response.data);
    } else {
      console.log('Error Message:', err.message);
    }
  }
})();
