const axios = require('axios');

(async () => {
  const url = 'https://integrate.api.nvidia.com/v1/chat/completions';
  const apiKey = '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';
  const model = 'meta/llama-3.3-70b-instruct';

  console.log(`Testing model ${model}...`);
  try {
    const res = await axios.post(url, {
      model: model,
      messages: [{ role: 'user', content: 'Xin chào, hãy trả lời ngắn gọn: Bạn là ai?' }],
      temperature: 0.7,
      max_tokens: 150
    }, {
      timeout: 15000,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      }
    });

    console.log('Response Status:', res.status);
    console.log('Response Text:', res.data.choices[0].message.content);

  } catch (err) {
    console.error('Error:', err.response ? err.response.data : err.message);
  }
})();
