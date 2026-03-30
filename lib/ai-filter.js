/**
 * AI-powered relevance filter for group discovery
 * Batched: 10 groups per AI call (cheap + accurate)
 * Uses DeepSeek cheapest model via /ai/generate
 * Fallback: keyword matching if AI unavailable
 */

const axios = require('axios')

const API_URL = process.env.API_URL || 'http://localhost:3000'
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
const BATCH_SIZE = 10 // groups per AI call — small batch = more accurate

const headers = () => ({
  'Content-Type': 'application/json',
  ...(SERVICE_KEY && { Authorization: `Bearer ${SERVICE_KEY}` }),
})

/**
 * Ask AI: is this batch of groups relevant to topic?
 * Returns array of relevant group indices (1-based)
 */
async function filterBatch(batch, topic, ownerId) {
  const list = batch.map((g, i) =>
    `${i + 1}. "${g.name}" (${g.member_count || '?'} members)`
  ).join('\n')

  const res = await axios.post(`${API_URL}/ai/generate`, {
    function_name: 'caption_gen',
    provider: 'deepseek',
    messages: [{
      role: 'user',
      content: `Chủ đề: "${topic}"
Ngôn ngữ yêu cầu: tiếng Việt hoặc tiếng Anh

${list}

Nhóm nào THỰC SỰ liên quan đến "${topic}"?
CHỈ chọn nhóm:
- Liên quan trực tiếp đến: ${topic}
- Tên nhóm bằng tiếng Việt hoặc tiếng Anh
LOẠI BỎ nhóm:
- Tiếng Trung, Thái, Nhật, Hàn hoặc ngôn ngữ khác
- Cá cược, game, MLM, giảm cân, mẹ bầu, thời trang, ẩm thực
- Mua bán, rao vặt không liên quan
Trả về JSON array số. VD: [1, 3] hoặc []`
    }],
    max_tokens: 100,
    temperature: 0,
  }, {
    timeout: 10000,
    headers: { ...headers(), ...(ownerId && { 'x-user-id': ownerId }) },
  })

  const text = res.data?.text || res.data?.result || ''
  const match = text.match(/\[[\d\s,]*\]/)
  if (match) {
    return JSON.parse(match[0]).filter(i => i >= 1 && i <= batch.length)
  }
  return []
}

/**
 * Filter groups by topic relevance using AI (batched)
 * @param {Array} groups - [{ name, member_count, ... }]
 * @param {string} topic - Search topic/keyword
 * @param {string} ownerId - User UUID for AI settings
 * @param {string} accountId - For logging
 * @returns {Array} Filtered groups that are relevant
 */
async function filterRelevantGroups(groups, topic, ownerId, accountId) {
  if (!groups.length) return []

  const scope = accountId ? accountId.slice(0, 8) : 'unknown'
  console.log(`[AI-FILTER] Evaluating ${groups.length} groups for topic "${topic}" (nick: ${scope})`)

  try {
    const relevant = []
    const rejected = []

    // Process in batches of BATCH_SIZE
    for (let i = 0; i < groups.length; i += BATCH_SIZE) {
      const batch = groups.slice(i, i + BATCH_SIZE)
      const batchNum = Math.floor(i / BATCH_SIZE) + 1
      const totalBatches = Math.ceil(groups.length / BATCH_SIZE)

      try {
        const indices = await filterBatch(batch, topic, ownerId)
        const accepted = indices.map(idx => batch[idx - 1]).filter(Boolean)
        const denied = batch.filter(g => !accepted.includes(g))

        relevant.push(...accepted)
        rejected.push(...denied)

        const names = accepted.map(g => g.name).join(', ') || '(none)'
        console.log(`[AI-FILTER] Batch ${batchNum}/${totalBatches}: ${accepted.length}/${batch.length} relevant [${names}]`)
      } catch (batchErr) {
        // If one batch fails, use keyword fallback for that batch only
        console.warn(`[AI-FILTER] Batch ${batchNum} failed: ${batchErr.message}, using keyword fallback`)
        const kw = keywordFilter(batch, topic)
        relevant.push(...kw)
        rejected.push(...batch.filter(g => !kw.includes(g)))
      }
    }

    console.log(`[AI-FILTER] Total: ${relevant.length}/${groups.length} relevant`)
    relevant.forEach(g => console.log(`  ✅ ${g.name}`))
    if (rejected.length <= 10) rejected.forEach(g => console.log(`  ❌ ${g.name}`))

    relevant._filterMeta = {
      submitted: groups.length,
      accepted: relevant.length,
      rejected_names: rejected.map(g => g.name).slice(0, 10),
      method: 'ai_batched',
      batches: Math.ceil(groups.length / BATCH_SIZE),
    }
    return relevant
  } catch (err) {
    console.warn(`[AI-FILTER] AI completely failed: ${err.message}, full keyword fallback`)
  }

  // Full fallback: keyword matching
  const fallback = keywordFilter(groups, topic)
  console.log(`[AI-FILTER] Keyword fallback: ${fallback.length}/${groups.length}`)
  fallback._filterMeta = {
    submitted: groups.length,
    accepted: fallback.length,
    rejected_names: groups.filter(g => !fallback.includes(g)).map(g => g.name).slice(0, 10),
    method: 'keyword_fallback',
  }
  return fallback
}

/**
 * Keyword-based fallback filter
 */
function keywordFilter(groups, topic) {
  const topicWords = topic.toLowerCase().split(/[\s,]+/).filter(w => w.length >= 2)
  const RELATED = {
    'vps': ['hosting', 'server', 'cloud', 'máy chủ', 'thuê'],
    'hosting': ['vps', 'server', 'web', 'domain', 'cloud'],
    'openclaw': ['openclaw', 'open claw', 'clawdbot', 'moltbot'],
    'server': ['vps', 'hosting', 'cloud', 'máy chủ'],
    'cloud': ['vps', 'server', 'aws', 'azure', 'hosting'],
  }
  const expanded = new Set(topicWords)
  for (const w of topicWords) {
    if (RELATED[w]) RELATED[w].forEach(r => expanded.add(r))
  }
  return groups.filter(g => {
    const text = `${g.name} ${g.description || ''}`.toLowerCase()
    return [...expanded].some(w => text.includes(w))
  })
}

/**
 * AI-powered keyword expansion for group discovery
 * Uses DeepSeek cheap model
 */
async function expandSearchKeywords(topic, mission, ownerId) {
  const baseKeywords = topic.split(/[,;]+/).map(k => k.trim()).filter(k => k.length > 1)

  try {
    const res = await axios.post(`${API_URL}/ai/generate`, {
      function_name: 'caption_gen',
      provider: 'deepseek',
      messages: [{
        role: 'user',
        content: `Tìm nhóm Facebook về: "${topic}"
${mission ? `Chi tiết: ${mission}` : ''}
Tạo 4-6 từ khóa tìm kiếm (tiếng Việt hoặc Anh).
Trả về CHỈ JSON array. VD: ["vps hosting", "thuê server"]`
      }],
      max_tokens: 150,
      temperature: 0.3,
    }, {
      timeout: 10000,
      headers: { ...headers(), ...(ownerId && { 'x-user-id': ownerId }) },
    })

    const text = res.data?.text || res.data?.result || ''
    const match = text.match(/\[[\s\S]*?\]/)
    if (match) {
      const aiKw = JSON.parse(match[0]).filter(k => typeof k === 'string' && k.length > 1)
      if (aiKw.length > 0) {
        const merged = [...new Set([...baseKeywords, ...aiKw])].slice(0, 6)
        console.log(`[AI-FILTER] Keyword expansion: "${topic}" → [${merged.join(', ')}]`)
        return merged
      }
    }
  } catch (err) {
    console.warn(`[AI-FILTER] Keyword expansion failed: ${err.message}`)
  }

  return baseKeywords
}

module.exports = { filterRelevantGroups, expandSearchKeywords }
