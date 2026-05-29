require('dotenv').config();

(async () => {
  const url = `${process.env.API_URL}/ai/generate`;
  console.log('Test post-session AI generate at:', url);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.AGENT_SECRET_KEY || process.env.AGENT_SECRET}`,
      },
      body: JSON.stringify({
        function_name: 'ai_pilot',
        messages: [{ role: 'user', content: 'test ping' }],
      })
    });
    console.log('Status:', res.status);
    const text = await res.text();
    console.log('Response:', text);
  } catch (err) {
    console.error('Error fetching:', err);
  }
})();
