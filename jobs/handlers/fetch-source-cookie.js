/**
 * Handler: fetch_source_cookie
 * 
 * This job type is used to re-fetch/sync cookies from a source account
 * to a destination (cookie mirroring). Currently not implemented in this
 * standalone agent version — gracefully no-op so jobs don't error.
 */

async function fetchSourceCookieHandler(payload, supabase) {
  const { account_id, source_account_id } = payload

  console.log(`[FETCH-COOKIE] Job received for account ${account_id?.slice(0, 8)} ← source ${source_account_id?.slice(0, 8) || 'N/A'}`)
  console.log(`[FETCH-COOKIE] Cookie sync is not supported in this agent version — skipping gracefully.`)

  // Return graceful skip result (job will be marked 'done' not 'failed')
  return {
    skipped: true,
    reason: 'fetch_source_cookie not implemented in standalone agent',
    account_id,
  }
}

module.exports = fetchSourceCookieHandler
