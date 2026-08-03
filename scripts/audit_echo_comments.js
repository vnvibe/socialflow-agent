require('dotenv').config()
const { Client } = require('pg')

const client = new Client({
  connectionString: process.env.DATABASE_URL
})

async function auditEchoComments() {
  await client.connect()
  console.log(`==================================================`)
  console.log(`[ECHO-AUDIT] Inspecting campaign_activity_log (last 30 days)...`)
  console.log(`==================================================`)

  const res = await client.query(`
    SELECT 
      cal.id,
      cal.created_at,
      c.name as campaign_name,
      a.username as nick_name,
      cal.target_name as group_name,
      cal.details->>'comment_text' as comment_text,
      cal.details->>'post_text' as post_text,
      cal.details->>'post_snippet' as post_snippet
    FROM campaign_activity_log cal
    LEFT JOIN campaigns c ON cal.campaign_id = c.id
    LEFT JOIN accounts a ON cal.account_id = a.id
    WHERE cal.action_type IN ('comment', 'opportunity_comment')
      AND cal.created_at >= NOW() - INTERVAL '30 days'
    ORDER BY cal.created_at DESC
  `)

  console.log(`Total comments analyzed in 30 days: ${res.rows.length}`)

  let echoCount = 0
  const echoRecords = []

  for (const r of res.rows) {
    const comment = (r.comment_text || '').toLowerCase().trim()
    const postSnippet = (r.post_snippet || r.post_text || '').toLowerCase().trim()
    if (!comment) continue

    const hasEchoMarker = comment.includes('bài viết gốc') || comment.includes('--- bài viết') || comment.includes('```') || comment.includes('post_snippet')
    const hasLongOverlap = postSnippet.length >= 20 && comment.includes(postSnippet.substring(0, 30))

    if (hasEchoMarker || hasLongOverlap) {
      echoCount++
      echoRecords.push({
        date: new Date(r.created_at).toISOString().split('T')[0],
        campaign: r.campaign_name || 'N/A',
        nick: r.nick_name || 'N/A',
        comment: r.comment_text.substring(0, 80),
        reason: hasEchoMarker ? 'contains_echo_marker' : 'contains_post_substring_echo'
      })
    }
  }

  console.log(`\nEcho / Verbatim repetitions found: ${echoCount} / ${res.rows.length} (${res.rows.length > 0 ? ((echoCount / res.rows.length) * 100).toFixed(1) : 0}%)`)
  if (echoRecords.length > 0) {
    console.table(echoRecords)
  } else {
    console.log(`✓ No verbatim echo repetitions found in ${res.rows.length} comments from last 30 days.`)
  }

  await client.end()
}

auditEchoComments().catch(console.error)
