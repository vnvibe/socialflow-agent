const axios = require('axios');

(async () => {
  const url = 'https://integrate.api.nvidia.com/v1/chat/completions';
  const apiKey = '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';
  const model = 'minimaxai/minimax-m2.7';

  try {
    const res = await axios.post(url, {
      model: model,
      messages: [{ role: 'user', content: 'Xin chào, hãy trả lời bằng 1 từ: Hello' }],
      temperature: 0.1,
      max_tokens: 500
    }, {
      timeout: 15000,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      }
    });

    console.log('Choices[0].message:', JSON.stringify(res.data.choices[0].message, null, 2));

  } catch (err) {
    console.error('Error:', err.message);
  }
})();
