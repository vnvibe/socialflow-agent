require('dotenv').config()
const { Client } = require('pg')
const { db } = require('../lib/db')
const { checkAndBoostKPI, getVnDateString } = require('../lib/kpi-booster')

const client = new Client({
  connectionString: process.env.DATABASE_URL
})

async function runMultiply() {
  await client.connect()
  const today = getVnDateString()

  console.log(`==================================================`)
  console.log(`[KPI-MULTIPLY] Tripling (x3) target_comments for date: ${today}`)
  console.log(`==================================================`)

  // 1. Multiply target_comments by 3 for today
  const updateRes = await client.query(`
    UPDATE nick_kpi_daily
    SET target_comments = GREATEST(15, target_comments * 3),
        kpi_met = false
    WHERE date = $1
    RETURNING id, account_id, campaign_id, target_comments, done_comments
  `, [today])

  console.log(`Updated ${updateRes.rowCount} row(s) in nick_kpi_daily:`)
  for (const r of updateRes.rows) {
    console.log(`  → Account:${r.account_id.slice(0,8)} Campaign:${r.campaign_id.slice(0,8)} target_comments now = ${r.target_comments} (done: ${r.done_comments})`)
  }

  await client.end()

  // 2. Trigger checkAndBoostKPI to auto-enqueue new high-priority redo jobs
  console.log(`\n[KPI-BOOSTER] Triggering checkAndBoostKPI for new x3 targets...`)
  const result = await checkAndBoostKPI(supabase, { forceNow: true })
  console.log(`\n[KPI-BOOSTER RESULT]:`, JSON.stringify(result, null, 2))
}

runMultiply().catch(console.error)
