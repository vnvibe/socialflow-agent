require('dotenv').config()
const { getApiClient } = require('../lib/api-client')

// ── sslip.io DNS Fallback ──
const dns = require('dns')
const originalLookup = dns.lookup
dns.lookup = function (hostname, options, callback) {
  if (hostname === '103-142-24-60.sslip.io') {
    if (typeof options === 'function') {
      callback = options
      options = {}
    }
    const ip = '103.142.24.60'
    const family = 4
    if (options && options.all) {
      return callback(null, [{ address: ip, family }])
    }
    return callback(null, ip, family)
  }
  return originalLookup.call(dns, hostname, options, callback)
}

async function main() {
  const api = getApiClient()
  console.log('Base URL:', api.baseUrl)
  console.log('Agent Secret:', api.agentSecret ? 'PRESENT' : 'MISSING')
  console.log('User ID:', api.userId)

  try {
    const jobs = await api.getPendingJobs(2)
    console.log('Pending Jobs from API:', JSON.stringify(jobs, null, 2))
  } catch (err) {
    console.error('API Error:', err.message)
    if (err.status) console.error('Status:', err.status)
  }
}

main().catch(console.error)
