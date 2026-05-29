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

    // 1. Fetch the campaign to get the ai_plan
    const campRes = await client.query('SELECT name, ai_plan, ai_plan_confirmed FROM campaigns WHERE id = $1', [campaignId]);
    if (campRes.rows.length === 0) {
      console.error('Campaign not found');
      return;
    }
    const campaign = campRes.rows[0];
    console.log(`Campaign name: "${campaign.name}"`);

    // 2. Update campaign status to running and is_active to true
    await client.query(`
      UPDATE campaigns 
      SET is_active = true, status = 'running', next_run_at = NOW() 
      WHERE id = $1
    `, [campaignId]);
    console.log('Updated campaigns table: is_active = true, status = "running"');

    // 3. Clear any existing roles for this campaign (just in case)
    await client.query('DELETE FROM campaign_roles WHERE campaign_id = $1', [campaignId]);
    console.log('Cleared existing campaign_roles');

    // 4. Parse the ai_plan and insert roles
    const aiPlan = campaign.ai_plan;
    if (aiPlan && Array.isArray(aiPlan.roles)) {
      console.log(`Found ${aiPlan.roles.length} roles in ai_plan. Creating roles...`);
      for (let i = 0; i < aiPlan.roles.length; i++) {
        const role = aiPlan.roles[i];
        
        const res = await client.query(`
          INSERT INTO campaign_roles 
            (campaign_id, name, role_type, account_ids, mission, parsed_plan, sort_order, is_active, config)
          VALUES 
            ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          RETURNING id, role_type
        `, [
          campaignId,
          role.name || `Role ${String.fromCharCode(65 + i)}`,
          role.role_type || 'custom',
          role.account_ids || [],
          role.mission || '',
          JSON.stringify(role.steps || null),
          i,
          true,
          JSON.stringify({})
        ]);
        
        console.log(`Created role: "${role.name}" (Type: ${role.role_type})`);
      }
    } else {
      console.log('No roles array found in ai_plan. Creating default nurture role...');
      // Default fallback nurture role
      await client.query(`
        INSERT INTO campaign_roles 
          (campaign_id, name, role_type, account_ids, mission, parsed_plan, sort_order, is_active, config)
        VALUES 
          ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      `, [
        campaignId,
        'Tương tác nhóm',
        'nurture',
        ['aeb73391-53ed-409b-9dbe-181a8b2679fd'], // Diệu Hiền
        'Tương tác nhóm',
        null,
        0,
        true,
        JSON.stringify({})
      ]);
      console.log('Created default nurture role.');
    }

    console.log('\n--- Sync Complete! Tino Campaign has been successfully configured and activated! ---');

  } catch (err) {
    console.error(err);
  } finally {
    await client.end();
  }
})();
