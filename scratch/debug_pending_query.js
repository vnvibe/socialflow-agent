const { Client } = require('pg');
require('dotenv').config();

const client = new Client({
  connectionString: process.env.DATABASE_URL
});

(async () => {
  try {
    await client.connect();
    console.log('Connected to PostgreSQL Database on VPS');

    const userId = '274868cf-742d-4d8a-89e8-bf1c37766b77';

    // Let's run a simplified query first to see if any pending jobs match the where conditions
    const simpleRes = await client.query(`
      SELECT id, type, payload->>'account_id' as account_id, created_by, payload->>'owner_id' as owner_id, status, scheduled_at 
      FROM jobs 
      WHERE status = 'pending' AND scheduled_at <= NOW()
        AND (created_by::text = $1 OR payload->>'owner_id' = $1)
    `, [userId]);

    console.log('Simple query matches count:', simpleRes.rows.length);
    console.log(simpleRes.rows.slice(0, 3));

    // Now let's run the exact query Fastify runs
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
        WHERE j.status = 'pending' AND j.scheduled_at <= now()
          AND (j.created_by::text = $1 OR j.payload->>'owner_id' = $1)
        ORDER BY j.payload->>'account_id' NULLS FIRST, j.type, j.priority ASC, j.scheduled_at ASC
      )
      SELECT * FROM one_per_nick_type
      ORDER BY _done_today ASC, _last_activity ASC, priority ASC, scheduled_at ASC
      LIMIT 80
    `;

    const fullRes = await client.query(sql, [userId]);
    console.log('\nFull Fastify query count:', fullRes.rows.length);
    if (fullRes.rows.length > 0) {
      console.log(fullRes.rows.slice(0, 3).map(r => ({ id: r.id, type: r.type, acc: r.payload?.account_id })));
    }

  } catch (err) {
    console.error(err);
  } finally {
    await client.end();
  }
})();
