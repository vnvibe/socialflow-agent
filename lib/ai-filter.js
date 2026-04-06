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
async function filterBatch(batch, topic, ownerId, campaignContext) {
  const list = batch.map((g, i) =>
    `${i + 1}. "${g.name}" (${g.member_count || '?'} members)`
  ).join('\n')

  // Build topic explanation so AI understands the business context
  const topicWords = topic.split(/[\s,]+/).filter(w => w.length > 1)
  const topicExplain = topicWords.join(', ')

  const res = await axios.post(`${API_URL}/ai/generate`, {
    function_name: 'caption_gen',
    provider: 'deepseek',
    messages: [{
      role: 'user',
      content: `Sản phẩm/dịch vụ: "${topicExplain}"
${campaignContext ? `Mục tiêu: ${campaignContext}` : ''}

${list}

Chọn nhóm có KHÁCH TIỀM NĂNG cho "${topicExplain}".

ĐỐI TƯỢNG cần tìm: Người có thể CẦN MUA hoặc SỬ DỤNG ${topicExplain}
Ví dụ: Người làm MMO cần VPS, dev cần hosting, startup cần cloud server, người dùng tool cần VPS chạy bot...

GIỮ LẠI (CẢ liên quan trực tiếp VÀ gián tiếp):
- Nhóm trực tiếp: VPS, hosting, server, cloud, ${topicExplain}
- Nhóm GIÁN TIẾP có khách tiềm năng: MMO, lập trình, dev, AI, automation, tool, coding, SEO, digital marketing, kinh doanh online, freelancer IT
- Nhóm cộng đồng tech/CNTT chung

CHỈ LOẠI BỎ nhóm CHẮC CHẮN 0% liên quan:
- Bất động sản, nhà đất, phòng trọ
- Thời trang, ẩm thực, nấu ăn, mẹ bầu, giảm cân
- Game mobile, cá cược, cá độ
- Mua bán đồ cũ, rao vặt chung
- Crypto/airdrop (trừ khi có yếu tố tech)

Trả về JSON array số. VD: [1, 3, 5] hoặc []`
    }],
    max_tokens: 100,
    temperature: 0,
  }, {
    timeout: 25000,
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
async function filterRelevantGroups(groups, topic, ownerId, accountId, supabase, campaignContext) {
  if (!groups.length) return []

  const scope = accountId ? accountId.slice(0, 8) : 'unknown'
  const topicKey = topic.toLowerCase().trim().replace(/\s+/g, '_').slice(0, 50)
  const CACHE_TTL = 7 * 24 * 3600 * 1000 // 7 days

  // Split: cached vs uncached groups
  const cached = []
  const uncached = []
  for (const g of groups) {
    const eval_ = g.ai_relevance?.[topicKey]
    if (eval_ && eval_.evaluated_at && (Date.now() - new Date(eval_.evaluated_at).getTime()) < CACHE_TTL) {
      if (eval_.relevant) cached.push(g)
      // else: cached as irrelevant → skip
    } else {
      uncached.push(g)
    }
  }

  if (cached.length > 0 || uncached.length < groups.length) {
    console.log(`[AI-FILTER] Cache: ${cached.length} relevant, ${groups.length - cached.length - uncached.length} irrelevant, ${uncached.length} new (nick: ${scope})`)
  }

  if (uncached.length === 0) return cached

  console.log(`[AI-FILTER] Evaluating ${uncached.length} new groups for topic "${topic}" (nick: ${scope})`)

  try {
    const relevant = [...cached]
    const rejected = []

    // Process uncached in batches
    for (let i = 0; i < uncached.length; i += BATCH_SIZE) {
      const batch = uncached.slice(i, i + BATCH_SIZE)
      const batchNum = Math.floor(i / BATCH_SIZE) + 1
      const totalBatches = Math.ceil(uncached.length / BATCH_SIZE)

      try {
        const indices = await filterBatch(batch, topic, ownerId, campaignContext)
        const accepted = indices.map(idx => batch[idx - 1]).filter(Boolean)
        const denied = batch.filter(g => !accepted.includes(g))

        relevant.push(...accepted)
        rejected.push(...denied)

        // Save AI eval to cache (async, don't block)
        if (supabase) {
          for (const g of accepted) {
            const prev = g.ai_relevance || {}
            prev[topicKey] = { relevant: true, score: 7, evaluated_at: new Date().toISOString() }
            supabase.from('fb_groups').update({ ai_relevance: prev }).eq('id', g.id).then(() => {}).catch(() => {})
          }
          for (const g of denied) {
            const prev = g.ai_relevance || {}
            prev[topicKey] = { relevant: false, score: 2, evaluated_at: new Date().toISOString() }
            supabase.from('fb_groups').update({ ai_relevance: prev }).eq('id', g.id).then(() => {}).catch(() => {})
          }
        }

        const names = accepted.map(g => g.name).join(', ') || '(none)'
        console.log(`[AI-FILTER] Batch ${batchNum}/${totalBatches}: ${accepted.length}/${batch.length} relevant [${names}]`)
      } catch (batchErr) {
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
    'vps': ['hosting', 'server', 'cloud', 'máy chủ', 'thuê', 'mmo', 'dev', 'lập trình'],
    'hosting': ['vps', 'server', 'web', 'domain', 'cloud', 'dev'],
    'openclaw': ['openclaw', 'open claw', 'clawdbot', 'moltbot', 'claude', 'vibe coding', 'ai tool'],
    'server': ['vps', 'hosting', 'cloud', 'máy chủ', 'mmo'],
    'cloud': ['vps', 'server', 'aws', 'azure', 'hosting'],
  }
  // Always include tech-adjacent groups as potential match
  const ALWAYS_MATCH = ['mmo', 'lập trình', 'dev', 'coding', 'automation', 'ai tool', 'claude', 'vibe']
  const expanded = new Set(topicWords)
  for (const w of topicWords) {
    if (RELATED[w]) RELATED[w].forEach(r => expanded.add(r))
  }
  // Add always-match keywords for tech topics
  if (topicWords.some(w => ['vps', 'hosting', 'server', 'cloud', 'openclaw', 'tool', 'dev'].includes(w))) {
    ALWAYS_MATCH.forEach(w => expanded.add(w))
  }
  // Blacklist: groups that should NEVER match for tech topics
  const BLACKLIST = ['cho thuê nhà', 'phòng trọ', 'bất động sản', 'nhà đất', 'rao vặt', 'mua bán đồ cũ', 've chai', 'thời trang', 'mỹ phẩm', 'giảm cân', 'mẹ bầu', 'nội thất', 'cá cược', 'cá độ']

  return groups.filter(g => {
    const text = `${g.name} ${g.description || ''}`.toLowerCase()
    // Reject if name contains blacklisted terms
    if (BLACKLIST.some(bl => text.includes(bl))) return false
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

/**
 * Per-group deep evaluation — visit group, read posts, AI decides
 * Called from discover handler after visiting each group page
 *
 * @param {object} groupInfo - { name, description, url, member_count, posts: [{ author, text }], language }
 * @param {string} topic - Campaign topic (e.g. "vps hosting, openclaw")
 * @param {string} ownerId - User UUID
 * @returns {{ relevant: boolean, reason: string, score: number, language: string }}
 */
async function evaluateGroup(groupInfo, topic, ownerId) {
  const { name, description, posts = [], member_count, language } = groupInfo

  // Format posts for AI — 8 bài cho đủ context đánh giá NỘI DUNG
  const postSamples = posts.slice(0, 8).map((p, i) =>
    `  Bài ${i + 1}: [${p.author || '?'}] "${(p.text || '').substring(0, 250)}"`
  ).join('\n')

  const topicWords = topic.toLowerCase().split(/[\s,]+/).filter(w => w.length > 2)
  const nameLower = (name || '').toLowerCase()
  const nameMatchesTopic = topicWords.some(w => nameLower.includes(w))

  // Nếu không có bài viết VÀ tên match → approve (không thể evaluate nội dung)
  // Nhưng nếu CÓ bài viết → LUÔN gửi AI đánh giá bằng nội dung
  if (nameMatchesTopic && posts.length === 0) {
    console.log(`[AI-EVAL] "${name}" → ✅ AUTO (name matches topic, no posts to evaluate)`)
    return {
      relevant: true,
      reason: `Tên nhóm chứa từ khóa topic: ${topicWords.filter(w => nameLower.includes(w)).join(', ')} (chưa có bài để đánh giá sâu)`,
      score: 7,
      language: language || 'vi',
    }
  }

  // Pre-compute spam indicators from posts
  const postTexts = posts.map(p => p.text || '')
  const postsWithLinks = postTexts.filter(t => /https?:\/\/|bit\.ly|t\.co|shopee|lazada/i.test(t)).length
  const spamRatio = posts.length > 0 ? (postsWithLinks / posts.length) : 0
  const spamWarning = spamRatio > 0.8 ? ' ⚠️ >80% bài có link — có thể là nhóm spam.' : ''

  const prompt = `Đánh giá nhóm Facebook này có KHÁCH TIỀM NĂNG cho sản phẩm/dịch vụ "${topic}" không.

=== THÔNG TIN SẢN PHẨM ===
Chủ đề: "${topic}"
Từ khóa liên quan: ${topicWords.join(', ')}

=== THÔNG TIN NHÓM ===
Tên nhóm: "${name}"
Mô tả: "${description || '(không có)'}"
Số thành viên: ${member_count || '?'}
Ngôn ngữ: ${language || '?'}
Tỷ lệ bài có link: ${Math.round(spamRatio * 100)}%${spamWarning}

Bài viết gần đây:
${postSamples || '  (không có bài — trang có thể chưa tải xong)'}

=== PHÂN LOẠI NHÓM ===

TIER 1 — "Tiềm năng" (score 8-10):
  Nhóm TRỰC TIẾP về topic. Thành viên CÓ NHU CẦU mua/dùng sản phẩm.
  → tag: "tier1_potential"

TIER 2 — "Triển vọng" (score 5-7):
  Nhóm GIÁN TIẾP — thành viên CÓ THỂ cần sản phẩm vì công việc liên quan.
  VD: Nhóm MMO/dev/AI → cần VPS chạy tool. Nhóm coding → cần hosting.
  → tag: "tier2_prospect"

TIER 3 — "Không phù hợp" (score 0-4):
  Nhóm KHÔNG liên quan hoặc spam.
  → tag: "tier3_irrelevant"

ĐÁNH GIÁ CHẤT LƯỢNG:
- risk_level "low": nhóm active, admin ổn, content chất lượng
- risk_level "medium": nhóm ít active, có spam nhẹ, admin có thể gắt
- risk_level "high": nhóm spam nhiều (>80% link), admin reject nhiều, hoặc nhóm chết

QUAN TRỌNG:
- Đọc TÊN + MÔ TẢ + NỘI DUNG BÀI → kết luận nhóm nói về gì
- Nhóm tech/dev/AI/automation/MMO/coding/freelancer = ít nhất TIER 2
- CHỈ TIER 3 nếu CHẮC CHẮN 0% liên quan
- Nếu >80% bài có link → risk_level "high" (spam group)

Trả về JSON:
{
  "relevant": true/false,
  "reason": "lý do ngắn",
  "note": "1-2 câu nhận xét cho người dùng review",
  "score": 0-10,
  "tier": "tier1_potential|tier2_prospect|tier3_irrelevant",
  "risk_level": "low|medium|high",
  "estimated_value": "high|medium|low",
  "language": "vi/en/zh/...",
  "sample_topics": ["chủ đề 1", "chủ đề 2"]
}`

  try {
    const res = await axios.post(`${API_URL}/ai/generate`, {
      function_name: 'group_eval',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 300,
      temperature: 0,
    }, {
      timeout: 20000,
      headers: { ...headers(), ...(ownerId && { 'x-user-id': ownerId }) },
    })

    const text = res.data?.text || res.data?.result || ''
    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (jsonMatch) {
      const result = JSON.parse(jsonMatch[0])
      const tier = result.tier || (result.score >= 8 ? 'tier1_potential' : result.score >= 5 ? 'tier2_prospect' : 'tier3_irrelevant')
      const riskLevel = result.risk_level || (spamRatio > 0.8 ? 'high' : spamRatio > 0.5 ? 'medium' : 'low')
      console.log(`[AI-EVAL] "${name}" → ${result.relevant ? '✅' : '❌'} (score: ${result.score}, ${tier}, risk: ${riskLevel}) — ${result.note || result.reason}`)
      return {
        relevant: result.relevant === true,
        reason: result.reason || '',
        note: result.note || result.reason || '',
        sample_topics: result.sample_topics || [],
        score: result.score || 0,
        tier,
        risk_level: riskLevel,
        estimated_value: result.estimated_value || (result.score >= 8 ? 'high' : result.score >= 5 ? 'medium' : 'low'),
        language: result.language || language || '?',
      }
    }
  } catch (err) {
    console.warn(`[AI-EVAL] AI failed for "${name}": ${err.message}`)
  }

  // Fallback: keyword match + language check
  const fallbackText = `${name} ${description || ''} ${posts.map(p => p.text).join(' ')}`.toLowerCase()
  const fallbackWords = topic.toLowerCase().split(/[\s,]+/).filter(w => w.length >= 2)
  const hasKeyword = fallbackWords.some(w => fallbackText.includes(w))
  const isForeignLang = /[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/.test(fallbackText.substring(0, 500))

  return {
    relevant: hasKeyword && !isForeignLang,
    reason: hasKeyword ? 'keyword match' : 'no keyword match',
    score: hasKeyword ? 5 : 0,
    language: isForeignLang ? 'foreign' : 'vi',
  }
}

/**
 * Extract group info from current page (name, desc, 2-3 posts)
 * Called while browser is on group page
 * @param {Page} page - Playwright page on a FB group
 * @returns {{ name, description, posts: [{author, text}], language, member_count }}
 */
async function extractGroupInfo(page) {
  // Scroll 3 lần để load thêm bài viết trước khi extract
  for (let i = 0; i < 3; i++) {
    await page.mouse.wheel(0, 300 + Math.random() * 200)
    await new Promise(r => setTimeout(r, 1500 + Math.random() * 1000))
  }

  return page.evaluate(() => {
    // Group name — thử nhiều selector, ưu tiên h1 trong main content
    let name = ''
    // 1. h1 trong [role="main"] (chính xác nhất)
    const mainH1 = document.querySelector('[role="main"] h1')
    if (mainH1) name = mainH1.textContent?.trim() || ''
    // 2. Fallback: h1 bất kỳ (nhưng lọc "Đoạn chat", "Messenger", etc.)
    if (!name || name.length < 3) {
      const allH1 = document.querySelectorAll('h1')
      for (const h of allH1) {
        const t = h.textContent?.trim() || ''
        if (t.length > 3 && !/^(Đoạn chat|Messenger|Facebook|Trang chủ)$/i.test(t)) {
          name = t; break
        }
      }
    }

    // Description from "Giới thiệu" section
    let description = ''
    const aboutEls = document.querySelectorAll('[role="main"] span[dir="auto"]')
    for (const el of aboutEls) {
      const text = el.textContent?.trim() || ''
      if (text.length > 30 && text.length < 500 && text !== name) {
        description = text
        break
      }
    }

    // Recent posts — lấy nhiều hơn (12 bài) để AI có đủ context đánh giá
    const posts = []
    const articles = document.querySelectorAll('[role="article"]')
    for (const article of [...articles].slice(0, 12)) {
      const parent = article.parentElement?.closest('[role="article"]')
      if (parent && parent !== article) continue

      const textEls = article.querySelectorAll('[dir="auto"]')
      let postText = ''
      for (const el of textEls) {
        const t = el.textContent?.trim() || ''
        if (t.length > 20 && t.length > postText.length) postText = t
      }
      const authorEl = article.querySelector('a[role="link"] strong, h3 a, h4 a')
      const author = authorEl?.textContent?.trim() || ''
      if (postText) posts.push({ author, text: postText.substring(0, 300) })
    }

    // Detect language — cần ít nhất 3 bài để kết luận chính xác
    const allText = posts.map(p => p.text).join(' ')
    const viChars = (allText.match(/[àáảãạăắằẳẵặâấầẩẫậèéẻẽẹêếềểễệìíỉĩịòóỏõọôốồổỗộơớờởỡợùúủũụưứừửữựỳýỷỹỵđ]/gi) || []).length
    const hasChinese = /[\u4e00-\u9fff]/.test(allText)
    // Cần ít nhất 5 ký tự có dấu mới kết luận là tiếng Việt
    // Nếu quá ít text → language = '?' (không chắc chắn)
    let language = '?'
    if (hasChinese) language = 'zh'
    else if (viChars >= 5) language = 'vi'
    else if (allText.length > 200 && viChars < 2) language = 'en'
    // else: '?' → không chắc, KHÔNG reject

    // Member count
    let memberCount = 0
    const memberTexts = document.querySelectorAll('[role="main"] span')
    for (const el of memberTexts) {
      const m = el.textContent?.match(/([\d,.]+)\s*(thành viên|members|người)/i)
      if (m) { memberCount = parseInt(m[1].replace(/[.,]/g, '')); break }
    }

    return { name, description, posts, language, member_count: memberCount }
  })
}

module.exports = { filterRelevantGroups, expandSearchKeywords, evaluateGroup, extractGroupInfo }
