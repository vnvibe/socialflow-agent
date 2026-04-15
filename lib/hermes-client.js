/**
 * Hermes Client — central wrapper for all AI calls in the agent
 *
 * Routes all AI requests through Hermes with fallback to legacy /ai/generate.
 * Logs every call with [HERMES] prefix for easy grep.
 * Fire-and-forget feedback loop for self-improvement metrics.
 */

const axios = require('axios')

const API_URL = process.env.API_URL || 'http://localhost:3000'
const AGENT_SECRET = process.env.AGENT_SECRET || ''
const AGENT_SECRET_KEY = process.env.AGENT_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || ''

const HERMES_ENABLED = !!AGENT_SECRET
const CALL_TIMEOUT_MS = 30000
const FALLBACK_TIMEOUT_MS = 20000

/**
 * Call Hermes with a specific task_type.
 *
 * @param {string} taskType — 'comment_gen' | 'reply_gen' | 'action_decision' | 'relevance_score' | 'lead_score' | 'quality_gate' | 'content_eval' | 'caption_gen' | 'generic'
 * @param {string} prompt — the main user prompt
 * @param {object} options — { context, maxTokens, temperature, messages, ownerId, accountId }
 * @returns {Promise<{text: string, source: 'hermes'|'fallback'|'error', latencyMs: number, taskType: string}>}
 */
async function callHermes(taskType, prompt, options = {}) {
  const {
    context = null,
    maxTokens,
    temperature,
    messages,
    ownerId,
    accountId,
    campaignId,
    groupFbId,
    silent = false,
  } = options

  const t0 = Date.now()
  const accTag = accountId ? ` account=${accountId.slice(0, 8)}` : ''

  // ── Try Hermes first ──
  if (HERMES_ENABLED) {
    try {
      const body = {
        task_type: taskType,
        prompt,
        context: context || undefined,
        max_tokens: maxTokens,
        temperature,
        messages,
        account_id: accountId,
        campaign_id: campaignId,
        group_fb_id: groupFbId,
      }
      // Drop undefined
      Object.keys(body).forEach(k => body[k] === undefined && delete body[k])

      const res = await axios.post(
        `${API_URL}/ai-hermes/agent/generate`,
        body,
        {
          timeout: CALL_TIMEOUT_MS,
          headers: {
            'Content-Type': 'application/json',
            'X-Agent-Key': AGENT_SECRET,
          },
        }
      )

      const latencyMs = Date.now() - t0
      const text = res.data?.text || ''
      const memCount = res.data?.memory_count || 0
      const fsCount = res.data?.fewshot_count || 0
      const memTag = memCount > 0 ? ` mem=${memCount}` : ''
      const fsTag = fsCount > 0 ? ` fs=${fsCount}` : ''
      if (!silent) console.log(`[HERMES] task=${taskType}${accTag} → OK (${latencyMs}ms, ${text.length}ch)${memTag}${fsTag}`)
      return { text, source: 'hermes', latencyMs, taskType, raw: res.data, memoryCount: memCount, fewshotCount: fsCount }
    } catch (err) {
      const code = err.response?.status || err.code || 'UNKNOWN'
      if (!silent) console.warn(`[HERMES] task=${taskType}${accTag} → FAIL (${code}: ${err.message}) — falling back`)
    }
  }

  // ── Fallback to /ai/generate (orchestrator with deepseek) ──
  try {
    const res = await axios.post(
      `${API_URL}/ai/generate`,
      {
        function_name: taskType,
        messages: messages || [{ role: 'user', content: prompt }],
        max_tokens: maxTokens || 500,
        temperature: temperature ?? 0.7,
      },
      {
        timeout: FALLBACK_TIMEOUT_MS,
        headers: {
          'Content-Type': 'application/json',
          ...(AGENT_SECRET_KEY && { Authorization: `Bearer ${AGENT_SECRET_KEY}` }),
          ...(ownerId && { 'x-user-id': ownerId }),
        },
      }
    )
    const latencyMs = Date.now() - t0
    const text = res.data?.text || res.data?.result || ''
    if (!silent) console.log(`[HERMES] task=${taskType}${accTag} → FALLBACK deepseek (${latencyMs}ms)`)
    return { text, source: 'fallback', latencyMs, taskType, raw: res.data }
  } catch (err) {
    const latencyMs = Date.now() - t0
    if (!silent) console.error(`[HERMES] task=${taskType}${accTag} → ERROR (${latencyMs}ms): ${err.message}`)
    return { text: '', source: 'error', latencyMs, taskType, error: err.message }
  }
}

/**
 * Call Hermes and parse JSON output (for structured tasks like scoring).
 * Returns parsed object or null on parse failure.
 */
async function callHermesJson(taskType, prompt, options = {}) {
  const result = await callHermes(taskType, prompt, options)
  if (!result.text) return { ...result, data: null }

  // Try to extract JSON from response
  let data = null
  try {
    const text = result.text.trim()
    // Handle ```json code blocks
    const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '')
    // Find first { or [
    const firstObj = cleaned.indexOf('{')
    const firstArr = cleaned.indexOf('[')
    let startIdx = -1
    if (firstObj === -1) startIdx = firstArr
    else if (firstArr === -1) startIdx = firstObj
    else startIdx = Math.min(firstObj, firstArr)

    if (startIdx === -1) return { ...result, data: null }

    const isArray = cleaned[startIdx] === '['
    const endChar = isArray ? ']' : '}'
    const endIdx = cleaned.lastIndexOf(endChar)
    if (endIdx === -1 || endIdx < startIdx) return { ...result, data: null }

    data = JSON.parse(cleaned.substring(startIdx, endIdx + 1))
  } catch (err) {
    console.warn(`[HERMES] JSON parse failed for ${taskType}: ${err.message}`)
  }

  return { ...result, data }
}

/**
 * Send feedback for a Hermes output — fire-and-forget.
 * Drives the self-improvement metrics shown in /hermes Brain page.
 *
 * @param {object} params — { taskType, outputText, score (1-5), accountId, reason }
 */
async function sendFeedback({ taskType, outputText, score, accountId, reason, context }) {
  if (!HERMES_ENABLED) return
  if (!taskType || !outputText || !score) return

  // Fire and forget — never block caller
  axios.post(
    `${API_URL}/ai-hermes/agent/feedback`,
    {
      task_type: taskType,
      output_text: outputText.substring(0, 500),
      score: Math.max(1, Math.min(5, Math.round(score))),
      account_id: accountId || null,
      reason: reason || null,
      context: context || null,
    },
    {
      timeout: 5000,
      headers: {
        'Content-Type': 'application/json',
        'X-Agent-Key': AGENT_SECRET,
      },
    }
  ).catch(() => {}) // silently drop — feedback is optional
}

/**
 * Specific helpers for common tasks (with sensible defaults).
 */

// Generate a reply to a comment/message
async function generateReply({ message, context = '', language = 'vi', accountId, campaignId, groupFbId }) {
  const prompt = `Reply to this ${language === 'en' ? 'comment' : 'bình luận'}:\n"${message}"\n${context ? `\nContext: ${context}` : ''}\nLanguage: ${language}\nKeep it natural and short.`
  return callHermes('reply_gen', prompt, { accountId, campaignId, groupFbId, maxTokens: 100, temperature: 0.8 })
}

// Decide action for a post during nurture browsing
async function decideAction({ post, campaignTopic, accountId, campaignId, groupFbId }) {
  const prompt = `Post: "${(post.text || '').substring(0, 400)}"\nAuthor: ${post.author || 'unknown'}\nReactions: ${post.reactions || 0}\nCampaign topic: ${campaignTopic}\n\nDecide action and return JSON.`
  return callHermesJson('action_decision', prompt, { accountId, campaignId, groupFbId, maxTokens: 200, temperature: 0.3 })
}

// Score a group/post for topic relevance
async function scoreRelevance({ content, topic, accountId, campaignId, groupFbId }) {
  const prompt = `Content: "${(content || '').substring(0, 500)}"\nTopic: ${topic}\n\nScore relevance and return JSON.`
  return callHermesJson('relevance_score', prompt, { accountId, campaignId, groupFbId, maxTokens: 150, temperature: 0.1 })
}

// Score a lead (profile/member) for prospect quality
async function scoreLead({ profile, topic, accountId, campaignId }) {
  const prompt = `Profile: ${JSON.stringify(profile).substring(0, 500)}\nTopic: ${topic}\n\nScore lead quality and return JSON.`
  return callHermesJson('lead_score', prompt, { accountId, campaignId, maxTokens: 200, temperature: 0.2 })
}

module.exports = {
  callHermes,
  callHermesJson,
  sendFeedback,
  generateReply,
  decideAction,
  scoreRelevance,
  scoreLead,
  HERMES_ENABLED,
}
