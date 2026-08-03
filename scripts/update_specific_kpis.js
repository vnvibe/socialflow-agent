require('dotenv').config()
const { Client } = require('pg')
const { db } = require('../lib/db')
const { checkAndBoostKPI, getVnDateString } = require('../lib/kpi-booster')

const client = new Client({
  connectionString: process.env.DATABASE_URL
})

async function runUpdateCustomKpi() {
  await client.connect()
  const today = getVnDateString()

  console.log(`==================================================`)
  console.log(`[KPI-CUSTOM-UPDATE] Updating specific target_comments for date: ${today}`)
  console.log(`==================================================`)

  // 1. Update Diệu Hiền (accounts starting with aeb73391 or nick containing 'Diệu Hiền') -> 12
  const dieuhienRes = await client.query(`
    UPDATE nick_kpi_daily k
    SET target_comments = 12, kpi_met = (done_comments >= 12)
    FROM accounts a
    WHERE k.account_id = a.id
      AND k.date = $1
      AND (a.id::text LIKE 'aeb73391%' OR a.username ILIKE '%Diệu Hiền%' OR a.notes ILIKE '%Diệu Hiền%')
    RETURNING k.id, a.username, a.notes, k.target_comments, k.done_comments
  `, [today])

  // 2. Update Dinh Thi Dinh (accounts starting with f58d8e8c or nick containing 'Dinh Thi Dinh') -> 10
  const dinhdinhRes = await client.query(`
    UPDATE nick_kpi_daily k
    SET target_comments = 10, kpi_met = (done_comments >= 10)
    FROM accounts a
    WHERE k.account_id = a.id
      AND k.date = $1
      AND (a.id::text LIKE 'f58d8e8c%' OR a.username ILIKE '%Dinh Thi Dinh%' OR a.notes ILIKE '%Dinh Thi Dinh%')
    RETURNING k.id, a.username, a.notes, k.target_comments, k.done_comments
  `, [today])

  // 3. Update Asplund Bang Ky (accounts starting with 7a8834a4 or nick containing 'Asplund') -> 6
  const asplundRes = await client.query(`
    UPDATE nick_kpi_daily k
    SET target_comments = 6, kpi_met = (done_comments >= 6)
    FROM accounts a
    WHERE k.account_id = a.id
      AND k.date = $1
      AND (a.id::text LIKE '7a8834a4%' OR a.username ILIKE '%Asplund%' OR a.notes ILIKE '%Asplund%')
    RETURNING k.id, a.username, a.notes, k.target_comments, k.done_comments
  `, [today])

  console.log(`Updated KPI targets:`)
  console.log(`  Diệu Hiền:`, dieuhienRes.rows)
  console.log(`  Dinh Thi Dinh:`, dinhdinhRes.rows)
  console.log(`  Asplund Bang Ky:`, asplundRes.rows)

  // 4. Cancel existing pending campaign_nurture jobs so we can re-enqueue with fresh payload
  await client.query(`
    DELETE FROM jobs
    WHERE type = 'campaign_nurture' AND status = 'pending' AND (payload->>'kpi_boost')::boolean = true
  `)
  console.log(`Cleaned pending old boost jobs.`)

  await client.end()

  // 5. Trigger checkAndBoostKPI to auto-enqueue new high-priority redo jobs with updated limits
  console.log(`\n[KPI-BOOSTER] Re-triggering checkAndBoostKPI for updated targets...`)
  const result = await checkAndBoostKPI(supabase, { forceNow: true })
  console.log(`\n[KPI-BOOSTER RESULT]:`, JSON.stringify(result, null, 2))
}

runUpdateCustomKpi().catch(console.error)
