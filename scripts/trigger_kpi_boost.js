require('dotenv').config()
const { Client } = require('pg')
const { db } = require('../lib/db')
const { checkAndBoostKPI, getVnDateString } = require('../lib/kpi-booster')

const client = new Client({
  connectionString: process.env.DATABASE_URL
})

async function runTrigger() {
  await client.connect()
  const today = getVnDateString()
  console.log(`==================================================`)
  console.log(`[KPI-REPORT] Analyzing daily KPI status for ${today}`)
  console.log(`==================================================`)

  const res = await client.query(`
    SELECT 
      k.date,
      c.name as campaign_name,
      c.status as campaign_status,
      a.username as nick_name,
      a.notes as nick_notes,
      k.target_comments, k.done_comments,
      k.target_likes, k.done_likes,
      k.target_friend_requests, k.done_friend_requests,
      k.target_group_joins, k.done_group_joins,
      k.kpi_met
    FROM nick_kpi_daily k
    JOIN campaigns c ON k.campaign_id = c.id
    JOIN accounts a ON k.account_id = a.id
    WHERE k.date = $1 AND (c.status IN ('active', 'running') OR c.is_active = true)
    ORDER BY c.name, a.username
  `, [today])

  if (res.rows.length === 0) {
    console.log(`No active campaign KPI rows recorded for today (${today}).`)
  } else {
    console.log(`\nActive Campaigns Daily KPI Breakdown (${res.rows.length} rows):`)
    console.table(res.rows.map(r => ({
      Campaign: `${r.campaign_name} (${r.campaign_status})`,
      Nick: r.nick_notes || r.nick_name,
      Comments: `${r.done_comments}/${r.target_comments}`,
      Likes: `${r.done_likes}/${r.target_likes}`,
      Friends: `${r.done_friend_requests}/${r.target_friend_requests}`,
      Joins: `${r.done_group_joins}/${r.target_group_joins}`,
      KPI_Met: r.kpi_met ? '✅ YES' : '❌ NO'
    })))
  }

  await client.end()

  // FIX Bug 1: db already imported at top of file — removed duplicate require inside function
  console.log(`\n[KPI-BOOSTER] Running checkAndBoostKPI...`)
  const result = await checkAndBoostKPI(db, { forceNow: true })
  console.log(`\n[KPI-BOOSTER RESULT]:`, JSON.stringify(result, null, 2))
}

runTrigger().catch(console.error)
