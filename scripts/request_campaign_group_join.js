const { Client } = require('pg');
require('dotenv').config();

const client = new Client({
  connectionString: process.env.DATABASE_URL
});

/**
 * Function: requestCampaignGroupJoin
 * Options:
 *  - campaignIdentifier: campaign ID or campaign name search (e.g. 'tino' or '4d164894-2...')
 *  - groupUrl: full FB group URL (e.g. 'https://www.facebook.com/groups/vnhermesagent')
 *  - fbGroupId: optional FB group numeric or slug ID ('vnhermesagent')
 *  - forceRetry: if true, forces re-enqueuing join jobs even if previously attempted
 */
async function requestCampaignGroupJoin({ campaignIdentifier, groupUrl, fbGroupId, forceRetry = true }) {
  await client.connect();
  console.log(`[REQUEST-JOIN] Processing group join request...`);
  console.log(`  Campaign: ${campaignIdentifier}`);
  console.log(`  Group URL: ${groupUrl}`);

  try {
    // 1. Resolve campaign
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(campaignIdentifier);
    let campaignRes;
    if (isUuid) {
      campaignRes = await client.query(
        `SELECT id, name, owner_id, status FROM campaigns WHERE id = $1 LIMIT 1`,
        [campaignIdentifier]
      );
    } else {
      campaignRes = await client.query(
        `SELECT id, name, owner_id, status FROM campaigns WHERE name ILIKE $1 LIMIT 1`,
        [`%${campaignIdentifier}%`]
      );
    }

    if (campaignRes.rows.length === 0) {
      // Fallback search for tino
      campaignRes = await client.query(
        `SELECT id, name, owner_id, status FROM campaigns WHERE name ILIKE '%tino%' LIMIT 1`
      );
    }

    if (campaignRes.rows.length === 0) {
      throw new Error(`Campaign '${campaignIdentifier}' not found in database.`);
    }

    const campaign = campaignRes.rows[0];
    console.log(`[REQUEST-JOIN] Found Campaign: "${campaign.name}" (${campaign.id}) | Owner: ${campaign.owner_id}`);

    // Extract group slug/id
    const gid = fbGroupId || groupUrl.match(/\/groups\/([^/?]+)/)?.[1] || 'vnhermesagent';
    const cleanUrl = groupUrl || `https://www.facebook.com/groups/${gid}`;

    // 2. Fetch all active accounts associated with this campaign or owner
    const accountsRes = await client.query(
      `SELECT id, username, notes, is_active, owner_id 
       FROM accounts 
       WHERE owner_id = $1 AND is_active = true`,
      [campaign.owner_id]
    );

    let accounts = accountsRes.rows;
    if (accounts.length === 0) {
      // Fallback to any active account
      const allActiveRes = await client.query(
        `SELECT id, username, notes, is_active, owner_id FROM accounts WHERE is_active = true LIMIT 5`
      );
      accounts = allActiveRes.rows;
    }

    console.log(`[REQUEST-JOIN] Found ${accounts.length} active account(s) for campaign.`);

    const createdJobs = [];
    const updatedGroups = [];

    for (const acc of accounts) {
      console.log(`\n--- Account: ${acc.notes || acc.username} (${acc.id}) ---`);

      // 3. Upsert into fb_groups table
      const fgRes = await client.query(
        `INSERT INTO fb_groups (account_id, fb_group_id, url, is_member, pending_approval, joined_via_campaign_id, topic)
         VALUES ($1, $2, $3, false, false, $4, 'tino_hermes')
         ON CONFLICT (account_id, fb_group_id) 
         DO UPDATE SET url = EXCLUDED.url, joined_via_campaign_id = COALESCE(fb_groups.joined_via_campaign_id, EXCLUDED.joined_via_campaign_id)
         RETURNING id, is_member, pending_approval, join_status`,
        [acc.id, gid, cleanUrl, campaign.id]
      );

      const fgRow = fgRes.rows[0];
      const groupRowId = fgRow.id;
      const isMember = fgRow.is_member;

      // 4. Upsert into campaign_groups junction table
      await client.query(
        `INSERT INTO campaign_groups (campaign_id, group_id, assigned_nick_id, status)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (campaign_id, group_id)
         DO UPDATE SET assigned_nick_id = EXCLUDED.assigned_nick_id`,
        [campaign.id, groupRowId, acc.id, isMember ? 'active' : 'paused']
      );

      updatedGroups.push({ accountId: acc.id, groupRowId, isMember });

      // 5. Check membership: if already member, skip joining
      if (isMember) {
        console.log(`  -> Already a member! Skipping join action.`);
        continue;
      }

      // 6. Schedule join_group job in database
      const payloadJson = JSON.stringify({
        account_id: acc.id,
        fb_group_id: gid,
        group_url: cleanUrl,
        campaign_id: campaign.id,
        owner_id: campaign.owner_id,
        force_now: true
      });

      const jobRes = await client.query(
        `INSERT INTO jobs (type, priority, payload, status, scheduled_at, created_by)
         VALUES ('join_group', 1, $1::jsonb, 'pending', NOW(), $2)
         RETURNING id, status, scheduled_at`,
        [payloadJson, campaign.owner_id]
      );

      const job = jobRes.rows[0];
      console.log(`  -> Enqueued join_group job: ID ${job.id} (status: ${job.status}, priority: 1, force_now: true)`);
      createdJobs.push(job.id);
    }

    console.log(`\n==================================================`);
    console.log(`[REQUEST-JOIN] SUCCESS!`);
    console.log(`  Campaign: ${campaign.name} (${campaign.id})`);
    console.log(`  Group: ${gid} (${cleanUrl})`);
    console.log(`  Enqueued ${createdJobs.length} join_group job(s).`);
    console.log(`==================================================\n`);

    return { success: true, campaignId: campaign.id, createdJobs };
  } catch (err) {
    console.error(`[REQUEST-JOIN] ERROR:`, err.message);
    throw err;
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const campaignArg = args[0] || 'tino';
  const groupUrlArg = args[1] || 'https://www.facebook.com/groups/vnhermesagent';

  requestCampaignGroupJoin({
    campaignIdentifier: campaignArg,
    groupUrl: groupUrlArg,
  }).catch(console.error);
}

module.exports = { requestCampaignGroupJoin };
