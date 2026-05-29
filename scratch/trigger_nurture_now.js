/**
 * Trigger fresh campaign_nurture jobs for both healthy nicks in Tino campaign
 * Run: node scratch/trigger_nurture_now.js
 */
require('dotenv').config()
const { Client } = require('pg')
const client = new Client({ connectionString: process.env.DATABASE_URL })

const CAMPAIGN_ID = 'b41bee21-2d52-48ca-ba21-357d6dd5ee0c' // Tino
const OWNER_ID = '274868cf-742d-4d8a-89e8-bf1c37766b77'

// Healthy nicks
const NICKS = [
  { id: 'aeb73391-53ed-409b-9dbe-181a8b2679fd', name: 'Diệu Hiền' },
  { id: '2cdd5c69-6ba1-461a-8709-60644c64d4a0', name: 'Việt Nguyễn' },
]

;(async () => {
  try {
    await client.connect()
    console.log('✅ Connected to VPS PostgreSQL\n')

    // Get role_id for campaign_nurture role in Tino campaign
    const roles = await client.query(`
      SELECT id, role_type, name FROM campaign_roles
      WHERE campaign_id = $1
      ORDER BY role_type
    `, [CAMPAIGN_ID])

    console.log('📋 Campaign roles:')
    for (const r of roles.rows) console.log(`  [${r.role_type}] "${r.name}" id=${r.id.slice(0,8)}`)

    const nurtureRole = roles.rows.find(r => r.role_type === 'nurture' || r.name?.toLowerCase().includes('tương tác'))
    if (!nurtureRole) {
      console.error('❌ No nurture role found in Tino campaign!')
      return
    }
    console.log(`\n✅ Using role: "${nurtureRole.name}" (${nurtureRole.id.slice(0,8)})\n`)

    // Cancel any stuck pending jobs first
    const stuck = await client.query(`
      UPDATE jobs SET status = 'cancelled', error_message = 'Manual reset before trigger test'
      WHERE status = 'pending'
        AND payload->>'campaign_id' = $1
        AND type = 'campaign_nurture'
      RETURNING id
    `, [CAMPAIGN_ID])
    console.log(`🧹 Cancelled ${stuck.rows.length} stuck pending nurture jobs`)

    // Create fresh jobs for each healthy nick
    for (const nick of NICKS) {
      const payload = {
        account_id: nick.id,
        campaign_id: CAMPAIGN_ID,
        role_id: nurtureRole.id,
        owner_id: OWNER_ID,
        created_by: OWNER_ID,
        force_now: true,  // bypass rest gate for immediate test
        topic: 'VPS Windows TinoHost, hosting, server, treo tool, OpenClaw',
        ad_mode: 'ad_enabled',
        brand_config: {
          brand_name: 'TinoHost',
          product: 'VPS Windows',
          cta: 'Truy cập tinohost.com để đăng ký VPS Windows giá rẻ',
          keywords: ['vps', 'hosting', 'server', 'treo tool', 'openclaw']
        }
      }

      const result = await client.query(`
        INSERT INTO jobs (type, status, priority, payload, created_by, owner_id, scheduled_at, max_attempts)
        VALUES ('campaign_nurture', 'pending', 5, $1::jsonb, $2, $2, NOW(), 3)
        RETURNING id
      `, [JSON.stringify(payload), OWNER_ID])

      const jobId = result.rows[0]?.id
      console.log(`✅ Created nurture job for ${nick.name}: ${jobId}`)
    }

    console.log('\n🚀 Done! Jobs are now pending and will be picked up by the agent.')
    console.log('Watch agent logs to confirm groups are loaded from campaign_groups junction.')

  } catch (err) {
    console.error('❌ Error:', err.message)
    console.error(err.stack)
  } finally {
    await client.end()
  }
})()
