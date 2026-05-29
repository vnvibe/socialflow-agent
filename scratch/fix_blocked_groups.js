/**
 * Fix: Clean up blocked groups, duplicates, and unblock valid groups
 * Run: node scratch/fix_blocked_groups.js
 */
require('dotenv').config()
const { Client } = require('pg')
const client = new Client({ connectionString: process.env.DATABASE_URL })

;(async () => {
  try {
    await client.connect()
    console.log('✅ Connected to VPS PostgreSQL\n')

    // Step 0: Find correct nick name column
    const schemaRes = await client.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'accounts' AND table_schema = 'public'
      ORDER BY ordinal_position
    `)
    const cols = schemaRes.rows.map(r => r.column_name)
    console.log(`accounts columns: ${cols.join(', ')}`)
    const nickCol = cols.includes('display_name') ? 'display_name'
      : cols.includes('full_name') ? 'full_name'
      : cols.includes('fb_name') ? 'fb_name'
      : cols.includes('username') ? 'username'
      : cols.find(c => c.includes('name')) || 'id'
    console.log(`Using nick column: "${nickCol}"\n`)

    // Step 1: Count duplicates
    const dupes = await client.query(`
      SELECT campaign_id, assigned_nick_id, group_id, COUNT(*) as cnt
      FROM campaign_groups
      GROUP BY campaign_id, assigned_nick_id, group_id
      HAVING COUNT(*) > 1
    `)
    console.log(`🔍 Duplicate campaign_groups rows: ${dupes.rows.length}`)

    // Step 2: Remove duplicates (keep one row with lowest id per unique combo)
    if (dupes.rows.length > 0) {
      const delDupes = await client.query(`
        DELETE FROM campaign_groups
        WHERE id NOT IN (
          SELECT MIN(id) FROM campaign_groups
          GROUP BY campaign_id, assigned_nick_id, group_id
        )
        RETURNING id
      `)
      console.log(`🗑️  Deleted ${delDupes.rows.length} duplicate rows`)
    }

    // Step 3: Unblock valid groups for HEALTHY nicks (Diệu Hiền, Việt Nguyễn)
    // Groups that are is_member=true should NOT be blocked
    const unblock = await client.query(`
      UPDATE fb_groups
      SET is_blocked = false
      WHERE is_member = true
        AND is_blocked = true
        AND account_id IN (
          SELECT id FROM accounts WHERE status = 'healthy'
        )
      RETURNING fb_group_id, account_id
    `)
    console.log(`\n✅ Unblocked ${unblock.rows.length} valid joined groups for healthy nicks`)

    // Step 4: Pause campaign_groups for groups that are NOT joined (is_member = false)
    // and not in pending_approval (these cannot be nurtured)
    const pauseNoMember = await client.query(`
      UPDATE campaign_groups cg
      SET status = 'paused'
      FROM fb_groups fg
      WHERE cg.group_id = fg.id
        AND fg.is_member = false
        AND fg.pending_approval = false
        AND cg.status = 'active'
      RETURNING cg.id, fg.fb_group_id
    `)
    console.log(`⏸️  Paused ${pauseNoMember.rows.length} not-joined group assignments`)

    // Step 5: Re-activate campaign_groups for groups that ARE joined (is_member=true)
    // and belong to healthy accounts
    const reactivate = await client.query(`
      UPDATE campaign_groups cg
      SET status = 'active'
      FROM fb_groups fg
      JOIN accounts a ON a.id = fg.account_id
      WHERE cg.group_id = fg.id
        AND fg.is_member = true
        AND fg.is_blocked = false
        AND fg.pending_approval = false
        AND a.status = 'healthy'
        AND cg.status = 'paused'
      RETURNING cg.id, fg.fb_group_id
    `)
    console.log(`▶️  Re-activated ${reactivate.rows.length} valid joined groups`)

    // Step 6: Final state check
    const finalState = await client.query(`
      SELECT 
        a.${nickCol} AS nick_name,
        a.status AS nick_status,
        fg.name AS group_name,
        fg.fb_group_id,
        fg.is_member,
        fg.is_blocked,
        cg.status AS cg_status
      FROM campaign_groups cg
      JOIN fb_groups fg ON fg.id = cg.group_id
      JOIN accounts a ON a.id = cg.assigned_nick_id
      WHERE a.status = 'healthy'
        AND cg.status = 'active'
        AND fg.is_member = true
        AND fg.is_blocked = false
      ORDER BY a.${nickCol}, fg.name
    `)

    console.log(`\n✅ ACTIVE RUNNABLE GROUPS for healthy nicks (${finalState.rows.length} total):`)
    for (const r of finalState.rows) {
      console.log(`  ✅ "${r.nick_name}" → "${r.group_name}" (${r.fb_group_id})`)
    }

    if (finalState.rows.length === 0) {
      console.log('\n⚠️  WARNING: No runnable groups found! Check fb_groups.is_member and is_blocked values.')
      
      // Debug: show all active campaign_groups for healthy nicks
      const debug = await client.query(`
        SELECT 
          a.${nickCol} AS nick_name,
          fg.name AS group_name,
          fg.is_member, fg.is_blocked, fg.pending_approval,
          cg.status AS cg_status
        FROM campaign_groups cg
        JOIN fb_groups fg ON fg.id = cg.group_id
        JOIN accounts a ON a.id = cg.assigned_nick_id
        WHERE a.status = 'healthy'
        ORDER BY a.${nickCol}, cg.status, fg.name
        LIMIT 30
      `)
      console.log('\n📋 All campaign_groups for healthy nicks:')
      for (const r of debug.rows) {
        const m = r.is_member ? '✅' : '❌'
        const b = r.is_blocked ? '🚫' : '  '
        console.log(`  ${m}${b} [${r.cg_status}] "${r.nick_name}" → "${r.group_name}"`)
      }
    }

  } catch (err) {
    console.error('❌ Error:', err.message)
    console.error(err.stack)
  } finally {
    await client.end()
    console.log('\n✅ Done.')
  }
})()
