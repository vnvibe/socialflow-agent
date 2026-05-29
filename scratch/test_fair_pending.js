const { Client } = require('pg');
require('dotenv').config();

const client = new Client({
  connectionString: process.env.DATABASE_URL
});

(async () => {
  await client.connect();
  console.log('Connected to PostgreSQL Database on VPS');

  const user_id = '274868cf-742d-4d8a-89e8-bf1c37766b77';
  const slots = 2;
  const args = [user_id, slots * 8];
  
  const where = [
    `j.status = 'pending'`,
    `j.scheduled_at <= now()`,
    `(j.created_by::text = $1 OR j.payload->>'owner_id' = $1)`
  ];

  const sql = `
    WITH vn_day_start AS (
      SELECT (date_trunc('day', (now() AT TIME ZONE 'Asia/Ho_Chi_Minh'))
              AT TIME ZONE 'Asia/Ho_Chi_Minh') AS ts
    ),
    nick_stats AS (
      SELECT
        payload->>'account_id' AS account_id,
        MAX(COALESCE(started_at, finished_at, created_at))        AS last_activity,
        COUNT(*) FILTER (
          WHERE status = 'done' AND finished_at >= (SELECT ts FROM vn_day_start)
        )::int AS done_today
      FROM jobs
      WHERE payload ? 'account_id'
      GROUP BY payload->>'account_id'
    ),
    one_per_nick_type AS (
      SELECT DISTINCT ON (j.payload->>'account_id', j.type)
        j.*,
        COALESCE(ns.last_activity, '1970-01-01'::timestamptz) AS _last_activity,
        COALESCE(ns.done_today, 0)                            AS _done_today
      FROM jobs j
      LEFT JOIN nick_stats ns ON ns.account_id = j.payload->>'account_id'
      WHERE ${where.join(' AND ')}
      ORDER BY j.payload->>'account_id' NULLS FIRST, j.type, j.priority ASC, j.scheduled_at ASC
    )
    SELECT * FROM one_per_nick_type
    ORDER BY _done_today ASC, _last_activity ASC, priority ASC, scheduled_at ASC
    LIMIT $2
  `;

  try {
    const { rows } = await client.query(sql, args);
    console.log(`\nFound ${rows.length} pending jobs:`);
    for (const r of rows) {
      console.log(`- Job ID: ${r.id}, Type: ${r.type}, Nick: ${r.payload?.account_id}, Status: ${r.status}`);
    }
  } catch (err) {
    console.error('SQL Execution failed:', err);
  }

  await client.end();
})();
