const { Client } = require('pg');
require('dotenv').config();

const client = new Client({
  connectionString: process.env.DATABASE_URL
});

async function run() {
  await client.connect();
  console.log('Fetching campaign & agent details...');

  const campaigns = await client.query('SELECT id, name, owner_id, is_active FROM campaigns');
  console.log('\nCampaigns:');
  for (const c of campaigns.rows) {
    console.log(`- Campaign: ${c.name} | ID: ${c.id} | Owner: ${c.owner_id} | Active: ${c.is_active}`);
  }

  const agents = await client.query('SELECT agent_id, machine_name, owner_id, status FROM agent_heartbeats');
  console.log('\nAgents:');
  for (const a of agents.rows) {
    console.log(`- Agent: ${a.agent_id} | Machine: ${a.machine_name} | Owner: ${a.owner_id} | Status: ${a.status}`);
  }

  await client.end();
}

run().catch(console.error);
