const { Client } = require('pg');
require('dotenv').config();

const client = new Client({
  connectionString: 'postgresql://socialflow:sf_secure_2026_rot_4821a@103.142.24.60:5432/socialflow'
});

(async () => {
  try {
    await client.connect();
    console.log('Connected to PostgreSQL Database on VPS');

    const callsRes = await client.query(`
      SELECT id, task_type, ok, error_message, latency_ms, created_at, prompt_preview, output_preview
      FROM hermes_calls 
      WHERE task_type = 'kpi_coordinator'
      ORDER BY created_at DESC
      LIMIT 10
    `);
    console.log('\n--- Recent Hermes Calls ---');
    if (callsRes.rows.length === 0) {
      console.log('No calls recorded.');
    } else {
      for (const c of callsRes.rows) {
        console.log(`- Time: ${c.created_at} | Task: ${c.task_type} | Ok: ${c.ok} | Latency: ${c.latency_ms}ms | Err: ${c.error_message || 'none'}`);
        console.log(`  Output: ${c.output_preview}`);
      }
    }

  } catch (err) {
    console.error('Error running check:', err);
  } finally {
    await client.end();
  }
})();
