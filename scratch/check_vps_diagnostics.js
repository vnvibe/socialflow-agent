const jwt = require('jsonwebtoken');
require('dotenv').config();

const JWT_SECRET = "super-secret-jwt-token-with-at-least-32-characters-long";
const USER_ID = "274868cf-742d-4d8a-89e8-bf1c37766b77";
const USER_EMAIL = "1phut30giayvi@gmail.com";

// Sign JWT token
const token = jwt.sign(
  { id: USER_ID, email: USER_EMAIL, role: 'admin' },
  JWT_SECRET,
  { expiresIn: '1h' }
);

console.log('Generated JWT Token:', token);

const API_BASE = "https://103-142-24-60.sslip.io";

async function fetchDiagnostics() {
  try {
    // 1. Get /status
    console.log('\n--- Fetching /status ---');
    let res = await fetch(`${API_BASE}/status`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    console.log('Status Code:', res.status);
    let json = await res.json();
    console.log('Result:', JSON.stringify(json, null, 2));

    // 2. Get /performance
    console.log('\n--- Fetching /performance ---');
    res = await fetch(`${API_BASE}/performance`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    console.log('Status Code:', res.status);
    json = await res.json();
    console.log('Skills Performance summary:');
    if (json.skills) {
      json.skills.forEach(s => {
        console.log(`  - ${s.task_type}: count=${s.count}, errors=${s.errors}, avg_lat=${s.avg_latency_ms}ms, score=${s.avg_score}`);
      });
    }
    console.log('\nRecent Calls (Last 5):');
    if (json.recent_calls) {
      json.recent_calls.slice(0, 5).forEach((c, idx) => {
        const dateStr = new Date(c.ts * 1000).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
        console.log(`  [${idx+1}] Time: ${dateStr} | Task: ${c.task_type} | Ok: ${c.ok} | Latency: ${c.latency_ms}ms`);
        console.log(`      Prompt: ${c.prompt.substring(0, 150)}...`);
        console.log(`      Output: ${c.output.substring(0, 150)}...`);
      });
    }

    // 3. Get /ai-hermes/health-summary
    console.log('\n--- Fetching /ai-hermes/health-summary ---');
    res = await fetch(`${API_BASE}/ai-hermes/health-summary`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    console.log('Status Code:', res.status);
    json = await res.json();
    console.log('Result:', JSON.stringify(json, null, 2));

  } catch (err) {
    console.error('Error fetching diagnostics:', err);
  }
}

fetchDiagnostics();
