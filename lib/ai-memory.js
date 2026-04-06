/**
 * AI Pilot Memory — persistent learning across campaign runs
 *
 * Stores observations as key-value pairs with confidence scoring.
 * Confidence increases with evidence, decays weekly without new observations.
 *
 * Memory types:
 *   campaign_pattern — campaign-level learnings (best hours, comment rates)
 *   nick_behavior    — per-nick patterns (success rates, risk triggers)
 *   group_response   — per-group signals (ad sensitivity, peak hours)
 */

const { supabase } = require('./supabase')

/**
 * Store or update a memory observation.
 * If memory with same key exists: merges value, increases confidence + evidence_count.
 * If new: creates with default confidence 0.5.
 *
 * @param {object} sb - Supabase client (optional, defaults to module client)
 * @param {object} opts
 * @param {string} opts.campaignId - Campaign UUID (required)
 * @param {string} [opts.accountId] - Account UUID (null = campaign-level)
 * @param {string} [opts.groupFbId] - Group FB ID (null = not group-specific)
 * @param {string} opts.memoryType - 'campaign_pattern' | 'nick_behavior' | 'group_response'
 * @param {string} opts.key - Memory key (e.g. 'best_comment_hour')
 * @param {*} opts.value - Memory value (any JSON-serializable)
 * @param {number} [opts.confidence] - Override confidence (0-1)
 */
async function remember(sb, { campaignId, accountId, groupFbId, memoryType, key, value, confidence }) {
  if (!campaignId || !memoryType || !key) return
  const client = sb || supabase

  try {
    // Check if exists
    let query = client
      .from('ai_pilot_memory')
      .select('id, confidence, evidence_count, value')
      .eq('campaign_id', campaignId)
      .eq('memory_type', memoryType)
      .eq('key', key)

    // Handle null equality for composite unique key
    if (accountId) query = query.eq('account_id', accountId)
    else query = query.is('account_id', null)
    if (groupFbId) query = query.eq('group_fb_id', groupFbId)
    else query = query.is('group_fb_id', null)

    const { data: existing } = await query.maybeSingle()

    if (existing) {
      // Update: increase confidence and evidence count
      const newConfidence = confidence ?? Math.min(0.95, existing.confidence + 0.05)
      const { error } = await client.from('ai_pilot_memory').update({
        value,
        confidence: newConfidence,
        evidence_count: existing.evidence_count + 1,
        last_updated_at: new Date().toISOString(),
      }).eq('id', existing.id)

      if (error) console.warn(`[AI-MEMORY] Update failed for ${key}: ${error.message}`)
    } else {
      // Insert new memory
      const { error } = await client.from('ai_pilot_memory').insert({
        campaign_id: campaignId,
        account_id: accountId || null,
        group_fb_id: groupFbId || null,
        memory_type: memoryType,
        key,
        value,
        confidence: confidence ?? 0.5,
        evidence_count: 1,
      })

      if (error) console.warn(`[AI-MEMORY] Insert failed for ${key}: ${error.message}`)
    }
  } catch (err) {
    console.warn(`[AI-MEMORY] remember() error: ${err.message}`)
  }
}

/**
 * Recall memories matching filter criteria.
 * Returns sorted by confidence DESC.
 *
 * @param {object} sb - Supabase client
 * @param {object} opts - Filter: campaignId, accountId, groupFbId, memoryType
 * @returns {Array<{ key, value, confidence, evidence_count, last_updated_at }>}
 */
async function recall(sb, { campaignId, accountId, groupFbId, memoryType }) {
  const client = sb || supabase

  try {
    let query = client
      .from('ai_pilot_memory')
      .select('key, value, confidence, evidence_count, last_updated_at')
      .order('confidence', { ascending: false })

    if (campaignId) query = query.eq('campaign_id', campaignId)
    if (accountId) query = query.eq('account_id', accountId)
    if (groupFbId) query = query.eq('group_fb_id', groupFbId)
    if (memoryType) query = query.eq('memory_type', memoryType)

    // Only return memories with meaningful confidence
    query = query.gte('confidence', 0.15)

    const { data, error } = await query.limit(30)
    if (error) {
      console.warn(`[AI-MEMORY] recall() error: ${error.message}`)
      return []
    }
    return data || []
  } catch (err) {
    console.warn(`[AI-MEMORY] recall() error: ${err.message}`)
    return []
  }
}

/**
 * Format memories into readable text for AI prompt context.
 * @param {Array} memories - From recall()
 * @returns {string} Formatted text for AI prompt
 */
function formatMemoriesForPrompt(memories) {
  if (!memories?.length) return '(chưa có memory)'

  return memories.map(m => {
    const confPct = Math.round((m.confidence || 0) * 100)
    const val = typeof m.value === 'string' ? m.value : JSON.stringify(m.value)
    const valShort = val.length > 120 ? val.substring(0, 120) + '...' : val
    return `- ${m.key}: ${valShort} (tin cậy: ${confPct}%, ${m.evidence_count} lần quan sát)`
  }).join('\n')
}

/**
 * Decay old memories — reduce confidence for memories not updated recently.
 * Call weekly (e.g., from nurture-scheduler cron).
 *
 * @param {object} sb - Supabase client
 * @param {string} [campaignId] - Optional: decay only for specific campaign
 */
async function decayOldMemories(sb, campaignId) {
  const client = sb || supabase

  try {
    const oneWeekAgo = new Date(Date.now() - 7 * 86400000).toISOString()

    // Get memories not updated in 7+ days
    let query = client
      .from('ai_pilot_memory')
      .select('id, confidence, key')
      .lt('last_updated_at', oneWeekAgo)
      .gt('confidence', 0.1) // don't decay already-low ones

    if (campaignId) query = query.eq('campaign_id', campaignId)

    const { data: stale } = await query
    if (!stale?.length) return 0

    let decayed = 0
    let deleted = 0

    for (const mem of stale) {
      const newConf = Math.round((mem.confidence - 0.1) * 100) / 100
      if (newConf <= 0.1) {
        // Too low — delete
        await client.from('ai_pilot_memory').delete().eq('id', mem.id)
        deleted++
      } else {
        await client.from('ai_pilot_memory').update({
          confidence: newConf,
          last_updated_at: new Date().toISOString(), // reset timer after decay
        }).eq('id', mem.id)
        decayed++
      }
    }

    if (decayed + deleted > 0) {
      console.log(`[AI-MEMORY] Decay: ${decayed} reduced, ${deleted} deleted (${stale.length} stale)`)
    }
    return decayed + deleted
  } catch (err) {
    console.warn(`[AI-MEMORY] decayOldMemories error: ${err.message}`)
    return 0
  }
}

module.exports = { remember, recall, formatMemoriesForPrompt, decayOldMemories }
