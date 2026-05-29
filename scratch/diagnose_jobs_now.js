/**
 * Diagnose: Check current jobs status + campaign_groups assignment
 * Run: node scratch/diagnose_jobs_now.js
 */
require('dotenv').config()
const { Client } = require('pg')

const client = new Client({ connectionString: process.env.DATABASE_URL })

;(async () => {
  try {
    await client.connect()
    console.log('✅ Connected to VPS PostgreSQL\n')

    // 1. Pending jobs
    const pending = await client.query(`
      SELECT id, type, 
             payload->>'account_id' AS acc_id,
             payload->>'campaign_id' AS camp_id,
             status, scheduled_at, error_message
      FROM jobs
      WHERE status = 'pending'
      ORDER BY scheduled_at ASC
      LIMIT 20
    `)
    console.log(`\n📋 PENDING JOBS (${pending.rows.length}):`)
    for (const r of pending.rows) {
      console.log(`  [${r.type}] acc=${r.acc_id?.slice(0,8)} camp=${r.camp_id?.slice(0,8)} scheduled=${r.scheduled_at}`)
    }

    // 2. Recent done/failed jobs (last 2 hours)
    const recent = await client.query(`
      SELECT id, type,
             payload->>'account_id' AS acc_id,
             status, error_message, finished_at
      FROM jobs
      WHERE status IN ('done', 'failed', 'cancelled')
        AND finished_at > NOW() - INTERVAL '2 hours'
      ORDER BY finished_at DESC
      LIMIT 15
    `)
    console.log(`\n🕐 RECENT JOBS last 2h (${recent.rows.length}):`)
    for (const r of recent.rows) {
      const status = r.status === 'done' ? '✅' : r.status === 'failed' ? '❌' : '⊘'
      console.log(`  ${status} [${r.type}] acc=${r.acc_id?.slice(0,8)} err=${r.error_message || '-'} at=${r.finished_at}`)
    }

    // 2b. Check accounts schema
    const schemaRes = await client.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'accounts' AND table_schema = 'public'
      ORDER BY column_name
    `)
    const cols = schemaRes.rows.map(r => r.column_name)
    const nickCol = cols.includes('display_name') ? 'display_name' : cols.includes('full_name') ? 'full_name' : cols.includes('fb_name') ? 'fb_name' : cols.includes('username') ? 'username' : 'id'
    console.log(`\n🔎 accounts columns: ${cols.join(', ')}`)
    console.log(`   Using nick column: ${nickCol}`)

    // 3. Campaign groups assignment (who is assigned what)
    const groups = await client.query(`
      SELECT 
        cg.id,
        cg.campaign_id,
        cg.assigned_nick_id,
        cg.status AS cg_status,
        fg.fb_group_id,
        fg.name AS group_name,
        fg.is_member,
        fg.pending_approval,
        fg.is_blocked,
        fg.user_approved,
        a.${nickCol} AS nick_name,
        a.status AS nick_status
      FROM campaign_groups cg
      JOIN fb_groups fg ON fg.id = cg.group_id
      LEFT JOIN accounts a ON a.id = cg.assigned_nick_id
      ORDER BY a.${nickCol}, fg.name
    `)
    console.log(`\n👥 CAMPAIGN GROUPS ASSIGNMENT (${groups.rows.length} rows):`)
    for (const r of groups.rows) {
      const member = r.is_member ? '✅member' : '❌not_member'
      const pending = r.pending_approval ? '⏳pending' : ''
      const blocked = r.is_blocked ? '🚫blocked' : ''
      const approved = r.user_approved === false ? '❌not_approved' : ''
      console.log(`  nick="${r.nick_name}" (${r.nick_status}) → group="${r.group_name}" cg_status=${r.cg_status} ${member} ${pending} ${blocked} ${approved}`)
    }

    // 4. Accounts summary
    const accounts = await client.query(`
      SELECT id, name, status, is_active, created_at
      FROM accounts
      ORDER BY name
    `)
    console.log(`\n🧑 ACCOUNTS (${accounts.rows.length}):`)
    for (const r of accounts.rows) {
      const active = r.is_active ? '🟢' : '🔴'
      console.log(`  ${active} ${r.name} (${r.status}) id=${r.id.slice(0,8)}`)
    }

    // 5. Last agent heartbeat
    const heartbeat = await client.query(`
      SELECT agent_id, status, last_seen_at, running_jobs, jobs_today, version
      FROM agent_heartbeats
      ORDER BY last_seen_at DESC
      LIMIT 5
    `)
    console.log(`\n💓 AGENT HEARTBEATS:`)
    for (const r of heartbeat.rows) {
      console.log(`  ${r.agent_id} → ${r.status} last_seen=${r.last_seen_at} running=${r.running_jobs} today=${r.jobs_today} v${r.version}`)
    }

  } catch (err) {
    console.error('❌ Error:', err.message)
  } finally {
    await client.end()
    console.log('\n✅ Done.')
  }
})()
