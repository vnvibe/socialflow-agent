/**
 * AI-powered relevance filter for group discovery
 * Sends group list to AI → returns only relevant groups
 * Cost: ~$0.001-0.003 per call (500-1500 tokens)
 * Fallback: keyword matching if AI unavailable
 */

const axios = require('axios')

const API_URL = process.env.API_URL || process.env.RAILWAY_URL || 'https://socialflow-production.up.railway.app'
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || ''

/**
 * Filter groups by topic relevance using AI
 * @param {Array} groups - [{ name, member_count, ... }]
 * @param {string} topic - Search topic/keyword
 * @param {string} ownerId - User UUID for AI settings
 * @returns {Array} Filtered groups that are relevant
 */
async function filterRelevantGroups(groups, topic, ownerId, accountId) {
  if (!groups.length) return []

  const scope = accountId ? accountId.slice(0, 8) : 'unknown'
  console.log(`[AI-FILTER] Evaluating ${groups.length} groups for topic "${topic}" (nick: ${scope})`)

  const groupList = groups.map((g, i) =>
    `${i + 1}. "${g.name}" (${g.member_count || '?'} members)`
  ).join('\n')

  try {
    const res = await axios.post(`${API_URL}/ai/generate`, {
      function_name: 'caption_gen',
      messages: [
        {
          role: 'user',
          content: `Chủ đề cần tìm nhóm Facebook: "${topic}"

Danh sách nhóm tìm được:
${groupList}

Trả về CHỈ các số thứ tự nhóm THỰC SỰ liên quan đến chủ đề "${topic}".
Loại bỏ nhóm cá cược, game, lừa đảo, MLM, không liên quan.
Trả về JSON array số, VD: [1, 3, 5]
Nếu không có nhóm nào liên quan, trả về: []`
        }
      ],
      max_tokens: 200,
      temperature: 0.1,
    }, {
      timeout: 15000,
      headers: {
        'Content-Type': 'application/json',
        ...(SERVICE_KEY && { 'Authorization': `Bearer ${SERVICE_KEY}` }),
        ...(ownerId && { 'x-user-id': ownerId }),
      },
    })

    const text = res.data?.text || res.data?.result || ''
    const match = text.match(/\[[\d\s,]*\]/)
    if (match) {
      const indices = JSON.parse(match[0])
      const filtered = indices
        .filter(i => i >= 1 && i <= groups.length)
        .map(i => groups[i - 1])

      const rejected = groups.filter(g => !filtered.includes(g))
      console.log(`[AI-FILTER] ${filtered.length}/${groups.length} groups relevant to "${topic}"`)
      filtered.forEach(g => console.log(`  ✅ ${g.name}`))
      rejected.forEach(g => console.log(`  ❌ ${g.name}`))

      // Estimate cost: ~500 input + 100 output tokens
      const estimatedCost = 0.002

      // Attach metadata for activity logging
      filtered._filterMeta = {
        submitted: groups.length,
        accepted: filtered.length,
        rejected_names: rejected.map(g => g.name).slice(0, 10),
        method: 'ai',
        ai_cost: estimatedCost,
      }
      return filtered
    }
  } catch (err) {
    console.warn(`[AI-FILTER] AI failed, using keyword fallback: ${err.message}`)
  }

  // Fallback: keyword matching
  const topicWords = topic.toLowerCase().split(/[\s,]+/).filter(w => w.length >= 2)
  const fallback = groups.filter(g => {
    const text = `${g.name} ${g.description || ''}`.toLowerCase()
    return topicWords.some(w => text.includes(w))
  })
  console.log(`[AI-FILTER] Keyword fallback: ${fallback.length}/${groups.length} groups matched`)
  fallback._filterMeta = {
    submitted: groups.length,
    accepted: fallback.length,
    rejected_names: groups.filter(g => !fallback.includes(g)).map(g => g.name).slice(0, 10),
    method: 'keyword_fallback',
  }
  return fallback
}

/**
 * AI-powered keyword expansion for group discovery
 * Input: topic + mission text
 * Output: array of search keywords for Facebook group search
 * Cost: ~$0.001 per call
 */
async function expandSearchKeywords(topic, mission, ownerId) {
  const baseKeywords = topic.split(/[,;]+/).map(k => k.trim()).filter(k => k.length > 1)

  try {
    const res = await axios.post(`${API_URL}/ai/generate`, {
      function_name: 'caption_gen',
      messages: [{
        role: 'user',
        content: `Tôi cần tìm nhóm Facebook liên quan đến: "${topic}"
${mission ? `Chi tiết: ${mission}` : ''}

Tạo 4-6 từ khóa tìm kiếm nhóm Facebook bằng tiếng Việt (hoặc tiếng Anh nếu phù hợp).
Mỗi từ khóa nên nhắm đến 1 góc khác nhau: tên sản phẩm, ngành, cộng đồng, hỗ trợ...
Trả về CHỈ JSON array, VD: ["vps hosting vietnam", "thuê server", "cộng đồng devops"]`
      }],
      max_tokens: 200,
      temperature: 0.3,
    }, {
      timeout: 10000,
      headers: {
        'Content-Type': 'application/json',
        ...(SERVICE_KEY && { 'Authorization': `Bearer ${SERVICE_KEY}` }),
        ...(ownerId && { 'x-user-id': ownerId }),
      },
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

  console.log(`[AI-FILTER] Using base keywords: [${baseKeywords.join(', ')}]`)
  return baseKeywords
}

module.exports = { filterRelevantGroups, expandSearchKeywords }
