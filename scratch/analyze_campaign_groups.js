const { Client } = require('pg');
require('dotenv').config();

const client = new Client({
  connectionString: process.env.DATABASE_URL
});

(async () => {
  try {
    await client.connect();
    console.log('Connected to PostgreSQL Database on VPS');

    const campaignId = 'b41bee21-2d52-48ca-ba21-357d6dd5ee0c'; // Tino

    // Query campaign details
    const campRes = await client.query('SELECT id, name, ai_plan FROM campaigns WHERE id = $1', [campaignId]);
    console.log(`Campaign: ${campRes.rows[0].name}`);

    // Query campaign_groups and join with fb_groups
    const groupsRes = await client.query(`
      SELECT cg.id as junction_id, cg.status as junction_status, cg.assigned_nick_id, cg.tier,
             fg.id as group_db_id, fg.fb_group_id, fg.name as group_name, fg.url as group_url,
             fg.is_member, fg.pending_approval, fg.user_approved, fg.is_blocked, fg.blocked_reason, fg.account_id
      FROM campaign_groups cg
      JOIN fb_groups fg ON cg.group_id = fg.id
      WHERE cg.campaign_id = $1
    `, [campaignId]);

    console.log(`\nTotal Campaign Groups: ${groupsRes.rows.length}`);

    // Analyze duplicates by fb_group_id
    const groupMap = new Map();
    for (const g of groupsRes.rows) {
      if (!groupMap.has(g.fb_group_id)) {
        groupMap.set(g.fb_group_id, []);
      }
      groupMap.get(g.fb_group_id).push(g);
    }

    console.log('\n--- Group Duplication Analysis ---');
    let duplicateCount = 0;
    for (const [fbId, occurrences] of groupMap.entries()) {
      if (occurrences.length > 1) {
        duplicateCount++;
        console.log(`Group ID ${fbId} is duplicated ${occurrences.length} times:`);
        occurrences.forEach(o => {
          console.log(`  - Junction ID: ${o.junction_id}, Assigned Nick: ${o.assigned_nick_id}, Group Account: ${o.account_id}`);
          console.log(`    Name: "${o.group_name}", is_member: ${o.is_member}, junction_status: ${o.junction_status}`);
        });
      }
    }
    if (duplicateCount === 0) console.log('No duplicate groups found by fb_group_id!');

    // Analyze which nicks have joined which groups
    console.log('\n--- Nick Membership and Group Assignment ---');
    const nicksRes = await client.query('SELECT id, username, status FROM accounts');
    const nickNameMap = new Map(nicksRes.rows.map(n => [n.id, n.username]));

    const nickGroups = new Map();
    for (const g of groupsRes.rows) {
      const assignedNickId = g.assigned_nick_id;
      const assignedName = nickNameMap.get(assignedNickId) || 'Unassigned';
      if (!nickGroups.has(assignedNickId)) {
        nickGroups.set(assignedNickId, { name: assignedName, memberOf: [], notMember: [] });
      }
      if (g.is_member) {
        nickGroups.get(assignedNickId).memberOf.push(g.group_name);
      } else {
        nickGroups.get(assignedNickId).notMember.push(g.group_name);
      }
    }

    for (const [nickId, data] of nickGroups.entries()) {
      console.log(`\nNick: "${data.name}" (${nickId})`);
      console.log(`  Joined Groups (${data.memberOf.length}):`);
      data.memberOf.forEach(g => console.log(`    - "${g}"`));
      console.log(`  Not Joined/Pending Groups (${data.notMember.length}):`);
      data.notMember.forEach(g => console.log(`    - "${g}"`));
    }

  } catch (err) {
    console.error(err);
  } finally {
    await client.end();
  }
})();
