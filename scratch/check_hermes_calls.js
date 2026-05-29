const { Client } = require('pg');
require('dotenv').config();

const client = new Client({
  connectionString: process.env.DATABASE_URL
});

(async () => {
  try {
    await client.connect();
    console.log('Connected to PostgreSQL Database on VPS');

    const callsRes = await client.query(`
      SELECT id, task_type, ok, error_message, latency_ms, created_at, prompt_preview, output_preview
      FROM hermes_calls 
      WHERE created_at BETWEEN '2026-05-28 22:10:00+00' AND '2026-05-28 22:20:00+00'
      ORDER BY created_at DESC
    `);
    console.log('\n--- Hermes Calls between 22:10 and 22:20 UTC ---');
    if (callsRes.rows.length === 0) {
      console.log('No calls recorded in this window.');
    } else {
      for (const c of callsRes.rows) {
        console.log(`- Time: ${c.created_at} | Task: ${c.task_type} | Ok: ${c.ok} | Latency: ${c.latency_ms}ms | Err: ${c.error_message || 'none'}`);
        if (!c.ok) {
          console.log(`  Prompt: ${c.prompt_preview}`);
        }
      }
    }

  } catch (err) {
    console.error('Error running check:', err);
  } finally {
    await client.end();
  }
})();
