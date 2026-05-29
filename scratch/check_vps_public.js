require('dotenv').config();

const API_BASE = "https://103-142-24-60.sslip.io";

async function fetchPublic() {
  try {
    // 1. Get /health
    console.log('\n--- Fetching /health ---');
    let res = await fetch(`${API_BASE}/health`);
    console.log('Status Code:', res.status);
    let json = await res.json();
    console.log('Result:', JSON.stringify(json, null, 2));

    // 2. Get /ai-hermes/health
    console.log('\n--- Fetching /ai-hermes/health ---');
    res = await fetch(`${API_BASE}/ai-hermes/health`);
    console.log('Status Code:', res.status);
    json = await res.json();
    console.log('Result:', JSON.stringify(json, null, 2));

    // 3. Get /extension/config
    console.log('\n--- Fetching /extension/config ---');
    res = await fetch(`${API_BASE}/extension/config`);
    console.log('Status Code:', res.status);
    json = await res.json();
    console.log('Result:', JSON.stringify(json, null, 2));

  } catch (err) {
    console.error('Error fetching public diagnostics:', err);
  }
}

fetchPublic();
