const axios = require('axios');

(async () => {
  const url = 'https://integrate.api.nvidia.com/v1/chat/completions';
  const apiKey = process.env.NVIDIA_API_KEY;
  if (!apiKey) throw new Error('Missing NVIDIA_API_KEY');
  const model = 'minimaxai/minimax-m2.7';

  try {
    const res = await axios.post(url, {
      model: model,
      messages: [{ role: 'user', content: 'Xin chào, hãy trả lời bằng 1 từ: Hello' }],
      temperature: 0.1,
      max_tokens: 50
    }, {
      timeout: 15000,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      }
    });

    console.log('Full Response:', JSON.stringify(res.data, null, 2));

  } catch (err) {
    console.error('Error:', err.message);
  }
})();
