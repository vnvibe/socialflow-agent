const { db } = require('./lib/db');
const { rebalanceKPI } = require('/opt/socialflow/api/src/services/kpi-calculator');

async function run() {
  console.log('Running rebalance on VPS...');
  const res = await rebalanceKPI(db, '4d164894-929a-483f-96d0-fa57d8a0464a');
  console.log('Result:', JSON.stringify(res, null, 2));
}

run().catch(console.error);
