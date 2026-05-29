require('dotenv').config();

(async () => {
  const url = `${process.env.API_URL}/agent-jobs/pending?slots=2&user_id=${process.env.AGENT_USER_ID}`;
  console.log('Fetching:', url);
  console.log('Headers:');
  console.log('  X-Agent-Key:', process.env.AGENT_SECRET);
  console.log('  X-Agent-Id:', process.env.AGENT_ID);

  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'X-Agent-Key': process.env.AGENT_SECRET,
        'X-Agent-Id': process.env.AGENT_ID,
      }
    });
    console.log('Status:', res.status);
    const json = await res.json();
    console.log('Response:', JSON.stringify(json, null, 2));
  } catch (err) {
    console.error('Error fetching from API:', err);
  }
})();
