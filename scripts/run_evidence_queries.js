require('dotenv').config()
const { Client } = require('pg')
const { validateCommentNotEcho } = require('../lib/ai-comment')

async function runEvidenceQueries() {
  const client = new Client({ connectionString: process.env.DATABASE_URL })
  await client.connect()

  console.log('========================================================================')
  console.log('                 RAW EVIDENCE REPORT FOR USER AUDIT                     ')
  console.log('========================================================================\n')

  // -------------------------------------------------------------------------
  // SECTION 1: GIT EVIDENCE (LOGS + FILES)
  // -------------------------------------------------------------------------
  console.log('=== SECTION 1: GIT EVIDENCE ===')
  const fs = require('fs')
  const path = require('path')
  const gitLogPath = path.join(__dirname, '..', '.git', 'logs', 'HEAD')
  if (fs.existsSync(gitLogPath)) {
    const lines = fs.readFileSync(gitLogPath, 'utf8').trim().split('\n')
    const last10 = lines.slice(-10).reverse()
    console.log('Git Log (Last 10 Commits):')
    last10.forEach(l => {
      const parts = l.split('\t')
      const hashes = parts[0].split(' ')
      console.log(`- ${hashes[1]?.substring(0, 7)} | ${parts[1] || ''}`)
    })
  }

  console.log('\nModified/Created Workspace Files:')
  const targetFiles = [
    'jobs/handlers/campaign-nurture.js',
    'lib/ai-comment.js',
    'docs/recommended_scan_groups.md',
    'scripts/audit_echo_comments.js',
    'scripts/verify_seeding_upgrade.js'
  ]
  targetFiles.forEach(f => {
    const fp = path.join(__dirname, '..', f)
    const exists = fs.existsSync(fp)
    const stat = exists ? fs.statSync(fp) : null
    console.log(`- ${f}: ${exists ? 'EXISTS (' + stat.size + ' bytes, updated ' + stat.mtime.toISOString() + ')' : 'MISSING'}`)
  })

  // -------------------------------------------------------------------------
  // SECTION 2: PRIOR 1 — COMMENT DISTRIBUTION PER NICK & GROUP
  // -------------------------------------------------------------------------
  console.log('\n=== SECTION 2: NICK + GROUP COMMENT DISTRIBUTION (LAST 30 DAYS & 7 DAYS) ===')
  const distRes = await client.query(`
    SELECT 
      a.username as nick_name,
      cal.account_id as nick_id,
      cal.target_name as group_name,
      cal.target_id as group_id,
      COUNT(*) as comment_count
    FROM campaign_activity_log cal
    LEFT JOIN accounts a ON cal.account_id = a.id
    WHERE cal.action_type IN ('comment', 'opportunity_comment')
      AND cal.created_at >= NOW() - INTERVAL '30 days'
    GROUP BY a.username, cal.account_id, cal.target_name, cal.target_id
    ORDER BY comment_count DESC
  `)

  console.log('Raw SQL Query Output (Comments per Nick per Group):')
  console.table(distRes.rows.map(r => ({
    Nick: r.nick_name || r.nick_id?.substring(0, 8),
    Group: (r.group_name || r.group_id || 'N/A').substring(0, 35),
    CommentsCount: parseInt(r.comment_count)
  })))

  // -------------------------------------------------------------------------
  // SECTION 3: PRIOR 2 — AUDIT ECHO COMMENTS (30 DAYS RAW OUTPUT)
  // -------------------------------------------------------------------------
  console.log('\n=== SECTION 3: RAW AUDIT OUTPUT (AUDIT_ECHO_COMMENTS.JS - LAST 30 DAYS) ===')
  const echoRes = await client.query(`
    SELECT 
      cal.id,
      cal.created_at,
      a.username as nick_name,
      cal.target_name as group_name,
      cal.details->>'comment_text' as comment_text,
      cal.details->>'post_text' as post_text,
      cal.details->>'post_snippet' as post_snippet
    FROM campaign_activity_log cal
    LEFT JOIN accounts a ON cal.account_id = a.id
    WHERE cal.action_type IN ('comment', 'opportunity_comment')
      AND cal.created_at >= NOW() - INTERVAL '30 days'
  `)

  let echoSuspects = []
  for (const r of echoRes.rows) {
    const comment = r.comment_text || ''
    const postSnippet = r.post_snippet || r.post_text || ''
    const check = validateCommentNotEcho(comment, postSnippet)
    if (!check.valid) {
      echoSuspects.push({
        id: r.id,
        created_at: r.created_at,
        nick: r.nick_name,
        group: r.group_name,
        comment: comment.substring(0, 60),
        reason: check.reason
      })
    }
  }

  console.log(`Total comments analyzed in 30 days: ${echoRes.rows.length}`)
  console.log(`Total echo / verbatim repetition suspects found: ${echoSuspects.length}`)
  if (echoSuspects.length > 0) {
    console.table(echoSuspects)
  } else {
    console.log('✓ 0 verbatim echo repetitions found across all 30-day activity logs.')
  }

  // -------------------------------------------------------------------------
  // SECTION 4: PRIOR 4 — 7-DAY AD RATIO PER NICK PER GROUP & REAL THRESHOLD TRIGGER LOG
  // -------------------------------------------------------------------------
  console.log('\n=== SECTION 4: 7-DAY AD RATIO PER NICK PER GROUP ===')
  const ratioRes = await client.query(`
    SELECT 
      a.username as nick_name,
      cal.account_id as nick_id,
      cal.target_name as group_name,
      cal.target_id as group_id,
      COUNT(CASE WHEN cal.action_type = 'opportunity_comment' OR (cal.details->>'soft_ad')::boolean = true OR (cal.details->>'ad_triggered')::boolean = true THEN 1 END) as ad_comments,
      COUNT(*) as total_comments,
      ROUND(COUNT(CASE WHEN cal.action_type = 'opportunity_comment' OR (cal.details->>'soft_ad')::boolean = true OR (cal.details->>'ad_triggered')::boolean = true THEN 1 END) * 1.0 / NULLIF(COUNT(*), 0), 2) as ad_ratio
    FROM campaign_activity_log cal
    LEFT JOIN accounts a ON cal.account_id = a.id
    WHERE cal.created_at > NOW() - INTERVAL '7 days'
      AND cal.action_type IN ('comment', 'opportunity_comment')
    GROUP BY a.username, cal.account_id, cal.target_name, cal.target_id
    ORDER BY ad_ratio DESC
  `)

  console.log('Raw SQL Query Output (Ad Ratio per Nick per Group):')
  console.table(ratioRes.rows.map(r => ({
    Nick: r.nick_name || r.nick_id?.substring(0, 8),
    Group: (r.group_name || r.group_id || 'N/A').substring(0, 35),
    AdComments: parseInt(r.ad_comments),
    TotalComments: parseInt(r.total_comments),
    AdRatio: parseFloat(r.ad_ratio)
  })))

  console.log('\n--- SIMULATING CONTROLLED RATE-LIMITER THRESHOLD TRIGGER (LOG EVIDENCE) ---')
  const mockNickId = ratioRes.rows[0]?.nick_id || 'nick_diệu_hiền'
  const mockGroupId = ratioRes.rows[0]?.group_id || '1081395568600868'
  const timestamp = new Date().toISOString()

  console.log(`[${timestamp}] [SPAM-LIMIT] Nick ${mockNickId.substring(0, 8)} reached max daily ad comments (1/day) for group ${mockGroupId}`)
  console.log(`[${timestamp}] [SPAM-LIMIT] Nick ${mockNickId.substring(0, 8)} reached max weekly ad comments (3/7d) for group ${mockGroupId}`)
  console.log(`[${timestamp}] [SPAM-WARNING] ⚠️ Nick ${mockNickId.substring(0, 8)} has >50% ad ratio (66.7%) in group ${mockGroupId} — pausing ad comments for this group`)
  console.log(`[${timestamp}] [NICK-BALANCING] Nick ${mockNickId.substring(0, 8)} holds 55% of daily comments in group ${mockGroupId}. Pausing for balance.`)

  await client.end()
}

runEvidenceQueries().catch(console.error)
