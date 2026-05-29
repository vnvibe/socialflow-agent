/**
 * Deep fix: Remove ALL duplicates from campaign_groups regardless of campaign
 * and check what campaigns these groups belong to
 */
require('dotenv').config()
const { Client } = require('pg')
const client = new Client({ connectionString: process.env.DATABASE_URL })

;(async () => {
  try {
    await client.connect()
    console.log('✅ Connected\n')

    // Check campaigns
    const camps = await client.query(`
      SELECT id, name, status FROM campaigns ORDER BY created_at DESC LIMIT 10
    `)
    console.log('📋 CAMPAIGNS:')
    for (const c of camps.rows) console.log(`  [${c.status}] "${c.name}" id=${c.id.slice(0,8)}`)

    // Show all duplicates with campaign info
    const dupeDetail = await client.query(`
      SELECT 
        cg.assigned_nick_id,
        cg.group_id,
        cg.campaign_id,
        c.name AS camp_name,
        fg.fb_group_id,
        fg.name AS group_name,
        COUNT(*) as cnt
      FROM campaign_groups cg
      JOIN campaigns c ON c.id = cg.campaign_id
      JOIN fb_groups fg ON fg.id = cg.group_id
      GROUP BY cg.assigned_nick_id, cg.group_id, cg.campaign_id, c.name, fg.fb_group_id, fg.name
      HAVING COUNT(*) > 1
      ORDER BY cnt DESC
    `)
    console.log(`\n🔍 Duplicates per campaign (${dupeDetail.rows.length} groups):`)
    for (const r of dupeDetail.rows) {
      console.log(`  x${r.cnt} camp="${r.camp_name}" nick=${r.assigned_nick_id?.slice(0,8)} group="${r.group_name}"`)
    }

    if (dupeDetail.rows.length > 0) {
      // Delete duplicates keeping only ONE row per (campaign_id, assigned_nick_id, group_id)
      const del = await client.query(`
        DELETE FROM campaign_groups a
        USING campaign_groups b
        WHERE a.id > b.id
          AND a.campaign_id = b.campaign_id
          AND a.assigned_nick_id = b.assigned_nick_id
          AND a.group_id = b.group_id
        RETURNING a.id
      `)
      console.log(`\n🗑️  Deleted ${del.rows.length} true duplicates (same campaign+nick+group)`)
    }

    // Check same group assigned across different campaigns
    const crossCamp = await client.query(`
      SELECT 
        a.assigned_nick_id,
        a.group_id,
        fg.name AS group_name,
        array_agg(DISTINCT c.name) AS campaigns,
        COUNT(DISTINCT a.campaign_id) AS camp_count
      FROM campaign_groups a
      JOIN campaigns c ON c.id = a.campaign_id
      JOIN fb_groups fg ON fg.id = a.group_id
      GROUP BY a.assigned_nick_id, a.group_id, fg.name
      HAVING COUNT(DISTINCT a.campaign_id) > 1
    `)
    if (crossCamp.rows.length > 0) {
      console.log(`\n⚠️  Groups assigned to MULTIPLE campaigns for same nick (${crossCamp.rows.length}):`)
      for (const r of crossCamp.rows) {
        console.log(`  nick=${r.assigned_nick_id?.slice(0,8)} group="${r.group_name}" in ${r.camp_count} camps: ${r.campaigns.join(' | ')}`)
      }
    } else {
      console.log('\n✅ No cross-campaign duplicates found')
    }

    // Final clean state
    const final = await client.query(`
      SELECT 
        a.username AS nick,
        a.status AS nick_status,
        fg.name AS group_name,
        fg.fb_group_id,
        fg.is_member,
        fg.is_blocked,
        cg.status AS cg_status,
        c.name AS campaign
      FROM campaign_groups cg
      JOIN fb_groups fg ON fg.id = cg.group_id
      JOIN accounts a ON a.id = cg.assigned_nick_id
      JOIN campaigns c ON c.id = cg.campaign_id
      WHERE a.status = 'healthy'
        AND fg.is_member = true
        AND fg.is_blocked = false
        AND cg.status = 'active'
      ORDER BY a.username, fg.name
    `)
    console.log(`\n✅ FINAL: ${final.rows.length} runnable group assignments for healthy nicks:`)
    for (const r of final.rows) {
      console.log(`  ✅ "${r.nick}" → "${r.group_name}" [camp: ${r.campaign}]`)
    }

    // Trigger new nurture jobs for healthy nicks with active groups
    console.log('\n📊 Summary ready. Proceed to trigger nurture jobs if needed.')

  } catch (err) {
    console.error('❌ Error:', err.message)
    console.error(err.stack)
  } finally {
    await client.end()
    console.log('\nDone.')
  }
})()
