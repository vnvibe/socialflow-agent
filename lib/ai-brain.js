/**
 * AI Brain — Central decision-making module for SocialFlow Agent
 *
 * Every action goes through the Brain with FULL context:
 * - Campaign goal + target audience definition
 * - Nick persona + warmup stage
 * - Group culture + recent post patterns
 * - Performance history (what worked, what didn't)
 *
 * The Brain decides:
 * 1. Is this post worth engaging? (relevance + value scoring)
 * 2. Is this person worth connecting? (lead quality scoring)
 * 3. Is this comment good enough to post? (quality gate)
 * 4. What's the best action right now? (priority ranking)
 */

const axios = require('axios')

const API_URL = process.env.API_URL || 'http://localhost:3000'
// Auth priority: AGENT_SECRET_KEY (stable, no expiry) > SERVICE_ROLE > user JWT (expires)
const AUTH_TOKEN = process.env.AGENT_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.AGENT_USER_TOKEN || ''

const headers = (ownerId) => ({
  'Content-Type': 'application/json',
  ...(AUTH_TOKEN && { Authorization: `Bearer ${AUTH_TOKEN}` }),
  ...(ownerId && { 'x-user-id': ownerId }),
})

/**
 * Build structured context for AI calls
 * This is the KEY innovation — every AI call gets rich, relevant context
 */
function buildContext({ campaign, nick, group, recentActivity, topic }) {
  const sections = []

  // Campaign context — WHY are we doing this?
  if (campaign) {
    sections.push(`=== MỤC TIÊU CHIẾN DỊCH ===
Tên: ${campaign.name || 'N/A'}
Chủ đề: ${topic || campaign.topic || 'N/A'}
Yêu cầu: ${campaign.requirement || 'Tương tác tự nhiên, kết nối khách tiềm năng'}
Đối tượng mục tiêu: Người quan tâm đến "${topic || campaign.topic}" — có nhu cầu mua/dùng/tìm hiểu
KHÔNG phải đối tượng: Người bán cùng ngành (đối thủ), spam, MLM, content không liên quan`)
  }

  // Nick persona — WHO is commenting?
  if (nick) {
    const ageInDays = nick.created_at
      ? Math.floor((Date.now() - new Date(nick.created_at).getTime()) / 86400000)
      : 0
    const phase = ageInDays < 7 ? 'mới tạo (chỉ browse+like)'
      : ageInDays < 30 ? 'đang warm-up (comment nhẹ nhàng, tự nhiên)'
      : ageInDays < 90 ? 'đang phát triển (tương tác vừa phải)'
      : 'trưởng thành (tương tác bình thường)'

    sections.push(`=== NHÂN VẬT (NICK) ===
Tên: ${nick.username || 'N/A'}
Tuổi tài khoản: ${ageInDays} ngày — Giai đoạn: ${phase}
Vai trò: ${nick.role_description || nick.mission || 'Thành viên nhóm, tương tác tự nhiên'}
Phong cách: Nói chuyện tự nhiên, không quảng cáo lộ liễu, giúp đỡ mọi người`)
  }

  // Group context — WHERE are we?
  if (group) {
    sections.push(`=== NHÓM FACEBOOK ===
Tên nhóm: ${group.name || 'N/A'}
Số thành viên: ${group.member_count || '?'}
Mô tả: ${group.description || '(không có)'}
Loại nhóm: ${group.group_type || 'Cộng đồng'}`)
  }

  // Recent activity — WHAT worked before?
  if (recentActivity?.length) {
    const summary = recentActivity.slice(0, 5).map(a =>
      `- ${a.action}: "${(a.details?.comment_text || a.details?.target_name || '').substring(0, 60)}" → ${a.result_status || 'done'}`
    ).join('\n')
    sections.push(`=== HOẠT ĐỘNG GẦN ĐÂY ===
${summary}`)
  }

  return sections.join('\n\n')
}

/**
 * CORE DECISION: Evaluate if posts are worth engaging
 *
 * Instead of simple "pick the best ones", this gives AI full context
 * about WHY we target this topic, and asks for deep analysis per post
 *
 * Returns: [{ index, score, reason, action, comment_angle, ad_opportunity, ad_reason, lead_potential }]
 */
async function evaluatePosts({ posts, campaign, nick, group, topic, maxPicks, ownerId, adConfig, brandConfig, groupLanguage }) {
  if (!posts?.length) return []

  const context = buildContext({ campaign, nick, group, topic })

  // Detect group language from posts if not provided
  const lang = groupLanguage || detectGroupLanguage(posts)

  // Fix 2: include thread comments per post so AI scores against the discussion,
  // not just the post body. We render up to 3 comments inline.
  const postList = posts.map((p, i) => {
    const head = `${i + 1}. [${p.author || '?'}] "${(p.body || p.text || '').substring(0, 250)}"`
    const tc = Array.isArray(p.threadComments) ? p.threadComments.slice(0, 3) : []
    if (tc.length === 0) return head
    const threadStr = tc.map(c => `     ↳ ${c.author || '?'}: "${(c.text || '').substring(0, 150)}"`).join('\n')
    return `${head}\n${threadStr}`
  }).join('\n')

  // Build advertising section — accepts new brandConfig or legacy adConfig shape
  // AI decides ad_opportunity contextually — NO keyword matching
  const brand = brandConfig || adConfig || null
  const brandName = brand?.brand_name || brand?.product_name || ''
  const brandDescription = brand?.brand_description || brand?.product_description || ''
  let adSection = ''
  if (brandName) {
    adSection = `
=== THƯƠNG HIỆU CỦA CHÚNG TA ===
Tên: ${brandName}
${brandDescription ? `Mô tả: ${brandDescription}` : ''}

Với MỖI bài, đánh giá THÊM:
- "ad_opportunity": true nếu bài viết đang HỎI / TÌM KIẾM / THAN PHIỀN về vấn đề mà ${brandName} giải quyết được
- "ad_reason": 1 câu giải thích tại sao đây là cơ hội (hoặc tại sao không)
- "comment_angle": nếu ad_opportunity=true → gợi ý GÓC comment tự nhiên nhất
  Ví dụ: "suggest brand như người đã dùng thật", "chia sẻ kinh nghiệm dùng brand cho vấn đề tương tự"
- "lead_potential": true nếu TÁC GIẢ có vẻ là KHÁCH TIỀM NĂNG

QUAN TRỌNG về ad_opportunity:
- ✅ TRUE: "ai rcm vps giá oke", "vps lag quá", "đang tìm host cho website", "dùng cái nào tốt"
- ❌ FALSE: "share kinh nghiệm cá nhân", "hỏi về code", "bài quảng cáo của người khác", "thông báo sự kiện"
- KHÔNG dùng keyword matching — đánh giá theo NGỮ CẢNH thực sự
`
  }

  const langBlock = `
=== NGÔN NGỮ NHÓM ===
Nhóm này dùng ngôn ngữ chính: ${lang === 'en' ? 'English (tiếng Anh)' : lang === 'vi' ? 'Vietnamese (tiếng Việt)' : lang === 'mixed' ? 'Mixed (cả 2)' : 'Unknown'}

Với mỗi bài, THÊM field:
- "comment_language": "${lang === 'en' ? 'en' : 'vi'}" — match với ngôn ngữ MAJORITY của bài viết.
  Nếu bài tiếng Anh trong group VN → comment_language: "en"
  Nếu group mixed → ưu tiên "vi"
`

  const prompt = `${context}

=== DANH SÁCH BÀI VIẾT TRONG NHÓM ===
${postList}

=== NHIỆM VỤ ===
Bạn ĐANG Ở trong nhóm "${group?.name || '?'}" — nhóm này ĐÃ ĐƯỢC XÁC NHẬN liên quan đến "${topic}".
Chọn ${maxPicks || 2} bài để tương tác tự nhiên.

=== ĐỌC THREAD TRƯỚC KHI CHẤM ===
Mỗi bài viết phía trên có thể đi kèm các comment hiện có (dòng "↳"). Hãy:
1. Đọc post + thread để biết thảo luận đang xoay quanh vấn đề CỤ THỂ gì.
2. Nếu thread đã trả lời câu hỏi của post → score thấp hơn (đừng chen vô lặp lại).
3. comment_angle PHẢI bám vào câu hỏi/vấn đề ĐANG mở trong thread, không chung chung.
4. Bỏ qua những bài mà thread đã có brand competitor được khen — không đối đầu trực diện.

${langBlock}${adSection}
=== CÁCH CHẤM ĐIỂM ===
- 8-10: Người viết ĐANG HỎI hoặc TÌM KIẾM giải pháp liên quan "${topic}" → ƯU TIÊN CAO
- 6-7: Bài thảo luận về "${topic}", có thể góp ý hoặc chia sẻ kinh nghiệm
- 4-5: Bài trong nhóm, có liên quan gián tiếp, có thể comment tự nhiên
- 1-3: Bài không liên quan hoặc spam/quảng cáo → BỎ QUA

QUAN TRỌNG:
- Nhóm đã match topic → hầu hết bài TRONG nhóm đều liên quan ít nhất gián tiếp
- Bài hỏi giá, so sánh, tìm sản phẩm = KHÁCH TIỀM NĂNG → score 8+, lead_potential: true
- Bài chia sẻ kinh nghiệm, tutorial = CƠ HỘI TƯƠNG TÁC → score 6+
- CHỈ cho score thấp (<4) nếu bài THỰC SỰ spam hoặc hoàn toàn off-topic

CHỈ LOẠI BỎ:
- Bài quảng cáo từ ĐỐI THỦ bán cùng sản phẩm
- Bài spam rõ ràng
- Bài chỉ có link không nội dung

Trả về JSON array:
[{"index": 1, "score": 8, "reason": "...", "action": "comment", "comment_angle": "...", "comment_language": "vi", "ad_opportunity": false, "ad_reason": "...", "lead_potential": false}]

CHỈ trả về JSON, không giải thích.`

  try {
    const res = await axios.post(`${API_URL}/ai/generate`, {
      function_name: 'relevance_review',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 400,
      temperature: 0.1,
    }, {
      timeout: 15000,
      headers: headers(ownerId),
    })

    const text = res.data?.text || res.data?.result || ''
    const match = text.match(/\[[\s\S]*\]/)
    if (match) {
      const results = JSON.parse(match[0])
      // Score >= 4 = worth engaging (lowered from 5 — group already confirmed relevant)
      const filtered = results
        .filter(r => r.score >= 4 && r.index >= 1 && r.index <= posts.length)
        .sort((a, b) => b.score - a.score)
        .slice(0, maxPicks || 2)

      if (filtered.length > 0) return filtered

      // If AI scored everything < 4, log it but still pick the best ones
      const best = results
        .filter(r => r.index >= 1 && r.index <= posts.length && r.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, maxPicks || 2)
      if (best.length > 0) {
        console.log(`[AI-BRAIN] All posts scored < 4, using best available: ${best.map(b => `#${b.index}=${b.score}`).join(', ')}`)
        return best
      }
    }
  } catch (err) {
    console.warn(`[AI-BRAIN] evaluatePosts failed: ${err.message}`)
  }

  // Fallback: if AI fails or returns nothing, return first N posts (don't block campaign)
  console.log(`[AI-BRAIN] evaluatePosts fallback: returning first ${maxPicks || 2} eligible posts`)
  return posts.slice(0, maxPicks || 2).map((p, i) => ({
    index: i + 1,
    score: 5,
    reason: 'AI unavailable, default selection',
    action: 'comment',
    comment_angle: null,
    comment_language: lang === 'en' ? 'en' : 'vi',
  }))
}

/**
 * QUALITY GATE: Check if AI-generated comment is good enough before posting
 *
 * Scores: naturalness, relevance, value-add
 * Only approve if average >= 7
 */
async function qualityGateComment({ comment, postText, group, topic, nick, ownerId, threadComments }) {
  if (!comment || comment.length < 3) return { approved: false, reason: 'too_short' }

  // Fix 4: collapse the post + thread into a single corpus so the gate can check
  // whether the comment actually addresses one specific token from the discussion.
  const threadArr = Array.isArray(threadComments) ? threadComments.slice(0, 5) : []
  const threadStr = threadArr.map(c => `${c.author || '?'}: ${c.text || ''}`).join(' | ')

  // Quick heuristic checks (no AI needed)
  const lower = comment.toLowerCase()

  // Reject obvious template/generic/bot-like comments
  const genericPatterns = [
    /^hay (quá|lắm)?!?$/i,
    /^cảm ơn (bạn )?(chia sẻ|share)/i,
    /^thông tin (hữu ích|bổ ích)/i,
    /^(nice|good|ok|tuyệt|hay|noted)[!.]*$/i,
    /^👍|^💯|^🔥|^❤️|^👏|^🙏$/,
    /^đúng (vậy|rồi)/i,
    /^đồng ý/i,
    /mình cũng đang (tìm hiểu|trải nghiệm|quan tâm)/i,  // sáo rỗng
    /bạn đã thử .+ chưa\??/i,  // mẫu câu bán hàng
    /thấy (nó |nó )?xử lý (rất )?(mượt|tốt|nhanh)/i,  // bot review
    /rất (hay|bổ ích|hữu ích|tuyệt vời)/i,  // generic praise
    /mình (cũng )?hay dùng .+ (cho |để )/i,  // bán hàng gián tiếp
  ]
  if (genericPatterns.some(p => p.test(comment.trim()))) {
    return { approved: false, reason: 'generic_template', score: 2 }
  }

  // Reject if comment mentions topic too aggressively (looks like ad)
  if (topic) {
    const topicWords = topic.toLowerCase().split(/[\s,]+/).filter(w => w.length > 3)
    const topicMentions = topicWords.filter(w => lower.includes(w)).length
    if (topicMentions >= 3) {
      return { approved: false, reason: 'too_promotional', score: 3 }
    }
  }

  // AI quality check for longer comments
  if (comment.length > 20) {
    try {
      const res = await axios.post(`${API_URL}/ai/generate`, {
        function_name: 'caption_gen',
        provider: 'deepseek',
        messages: [{
          role: 'user',
          content: `Đánh giá bình luận Facebook sau:

BÀI GỐC (nhóm "${group?.name || '?'}"): "${(postText || '').substring(0, 200)}"
${threadStr ? `THREAD COMMENTS hiện có: ${threadStr.substring(0, 400)}\n` : ''}BÌNH LUẬN ĐANG ĐÁNH GIÁ: "${comment}"
CHỦ ĐỀ chiến dịch: "${topic || 'N/A'}"

Chấm điểm 1-10:
- naturalness: Có tự nhiên như người thật không? (không giống bot/template)
- relevance: Có trả lời ĐÚNG vấn đề CỤ THỂ trong post + thread không? (không chung chung, không lặp ý đã có)
- value: Có thêm thông tin mới so với những gì thread đã thảo luận không?

REJECT (approved=false) nếu:
- Comment không nhắc tới chi tiết cụ thể nào trong post hoặc thread
- Comment lặp lại ý đã có trong thread
- Comment hỏi câu đã được trả lời trong thread
- Comment chung chung kiểu "rất hay", "thông tin bổ ích", "mình cũng vậy"

Trả về JSON: {"naturalness": N, "relevance": N, "value": N, "approved": true/false, "reason": "..."}`
        }],
        max_tokens: 120,
        temperature: 0,
      }, {
        timeout: 8000,
        headers: headers(ownerId),
      })

      const text = res.data?.text || res.data?.result || ''
      const jsonMatch = text.match(/\{[\s\S]*?\}/)
      if (jsonMatch) {
        const result = JSON.parse(jsonMatch[0])
        const avg = ((result.naturalness || 0) + (result.relevance || 0) + (result.value || 0)) / 3
        return {
          approved: avg >= 6.5 && result.naturalness >= 5 && result.relevance >= 5,
          score: Math.round(avg * 10) / 10,
          naturalness: result.naturalness,
          relevance: result.relevance,
          value: result.value,
          reason: result.reason || (avg >= 6.5 ? 'passed' : 'below_threshold'),
        }
      }
    } catch (err) {
      console.warn(`[AI-BRAIN] qualityGate failed: ${err.message}`)
    }
  }

  // Default: approve if not caught by heuristics (avoid blocking everything)
  return { approved: true, reason: 'heuristic_pass', score: 7 }
}

/**
 * Evaluate profile for friend request — should we connect with this person?
 *
 * Enhanced version with:
 * - Richer profile data (friend_count, is_verified, post recency)
 * - Priority field (high/medium/low) for smart queue sorting
 * - Dedicated 'profile_eval' AI function (not shared caption_gen)
 * - Authenticity checks (fake profile signals)
 *
 * @param {Object} opts
 * @param {Object} opts.person - { name, fb_user_id, bio, introItems, posts, mutualFriends, friendCount, isVerified }
 * @param {string} opts.postContext - rich text context (bio + intro + posts + mutual info)
 * @param {Object} opts.campaign - campaign object
 * @param {string} opts.topic - campaign topic
 * @param {string} opts.ownerId - user UUID
 * @returns {{ score: number, worth: boolean, reason: string, type: string, priority: string }}
 */
async function evaluateProfileForConnect({ person, postContext, campaign, topic, ownerId }) {
  if (!person?.name && !person?.fb_user_id) return { score: 0, worth: false, priority: 'low', type: 'unknown', reason: 'no_identity' }

  const hasMinimalInfo = !person.name || person.name === '?' || person.name === ''
  const fromRelevantGroup = (postContext || '').toLowerCase().includes(topic?.toLowerCase()?.split(',')[0] || '')

  // Fast path: minimal info → default approve with medium priority
  if (hasMinimalInfo && fromRelevantGroup) {
    return { score: 6, worth: true, priority: 'medium', reason: `Thành viên nhóm liên quan "${topic}" — thiếu info nhưng approve do nhóm phù hợp`, type: 'potential_buyer' }
  }
  if (hasMinimalInfo) {
    return { score: 5, worth: true, priority: 'low', reason: 'Thiếu info, default approve', type: 'unknown' }
  }

  // Build profile summary for AI
  const profileParts = []
  if (person.name) profileParts.push(`Tên: ${person.name}`)
  if (person.bio) profileParts.push(`Bio: ${person.bio}`)
  if (person.introItems?.length) profileParts.push(`Giới thiệu: ${person.introItems.join(', ')}`)
  if (person.friendCount) profileParts.push(`Số bạn bè: ${person.friendCount}`)
  if (person.mutualFriends) profileParts.push(`Bạn chung: ${person.mutualFriends}`)
  if (person.isVerified) profileParts.push(`Đã xác minh: Có`)
  if (person.posts?.length) profileParts.push(`Bài gần đây (${person.posts.length}):\n${person.posts.map((p, i) => `  ${i + 1}. ${p}`).join('\n')}`)
  const profileSummary = profileParts.join('\n') || postContext || 'Không có thông tin'

  const prompt = `Đánh giá profile Facebook này để quyết định có nên GỬI LỜI MỜI KẾT BẠN không.

=== THÔNG TIN PROFILE ===
${profileSummary}

=== NGỮ CẢNH ===
Phát hiện từ: ${postContext || 'nhóm Facebook'}
Chiến dịch: "${campaign?.name || topic}" (chủ đề: ${topic})

=== TIÊU CHÍ ĐÁNH GIÁ ===
1. Liên quan đến "${topic}" (0-10): profile có quan tâm chủ đề này không?
2. Profile thật (0-10): tên thật, có ảnh, có hoạt động, có bạn bè hợp lý?
3. Mức độ hoạt động: có bài gần đây không? Có tương tác không?
4. Kết nối: bạn chung càng nhiều càng tốt (tăng cơ hội accept)

=== QUY TẮC ===
- Người TRONG nhóm liên quan → tín hiệu tích cực (score >= 5)
- Thiếu info → default approve (score 5-6), KHÔNG reject
- CHỈ reject nếu: spam rõ ràng, đối thủ bán hàng cùng ngành, profile giả
- Bạn chung > 5: bonus +1 score
- Profile verified: bonus +1 score
- Không có bài nào: trừ -1 score (nhưng vẫn có thể approve)

Trả về JSON duy nhất:
{"score": 0-10, "worth": true/false, "reason": "1 câu tiếng Việt", "type": "potential_buyer|competitor|irrelevant|spam", "priority": "high|medium|low"}

priority: high nếu score >= 8, medium nếu 6-7, low nếu < 6
Chỉ trả JSON, không giải thích.`

  try {
    const res = await axios.post(`${API_URL}/ai/generate`, {
      function_name: 'profile_eval',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 150,
      temperature: 0.1,
    }, {
      timeout: 10000,
      headers: headers(ownerId),
    })

    const text = res.data?.text || res.data?.result || ''
    const match = text.match(/\{[\s\S]*?\}/)
    if (match) {
      const result = JSON.parse(match[0])
      // Ensure priority field exists
      if (!result.priority) {
        result.priority = result.score >= 8 ? 'high' : result.score >= 6 ? 'medium' : 'low'
      }
      return result
    }
  } catch (err) {
    console.warn(`[AI-BRAIN] evaluateProfileForConnect failed: ${err.message}`)
  }

  return { score: 5, worth: true, priority: 'low', reason: 'ai_unavailable_default_allow', type: 'unknown' }
}

// Backward compatibility alias
const evaluateLeadQuality = evaluateProfileForConnect

/**
 * Generate comment with FULL context (replaces simple ai-comment.js call)
 *
 * Difference from old approach:
 * - Gets campaign goal, nick persona, group culture
 * - Gets comment_angle from evaluatePosts (knows WHY we're commenting)
 * - Generates contextual, value-adding response
 */
async function generateSmartComment({ postText, postAuthor, group, campaign, nick, topic, commentAngle, ownerId, adConfig, hasAdOpportunity, language, threadComments }) {
  const context = buildContext({ campaign, nick, group, topic })
  const lang = language === 'en' ? 'en' : 'vi'

  // Fix 2: render visible thread comments so AI doesn't repeat what was already said
  const threadArr = Array.isArray(threadComments) ? threadComments.slice(0, 5) : []
  const threadBlock = threadArr.length > 0
    ? (lang === 'en'
        ? `\n=== THREAD DISCUSSION (existing comments) ===\n${threadArr.map(c => `- ${c.author || '?'}: "${(c.text || '').substring(0, 200)}"`).join('\n')}\n\nYour comment MUST address the actual ongoing discussion. Do NOT repeat what someone already said. Do NOT ask a question that's already been answered above.`
        : `\n=== THREAD ĐANG THẢO LUẬN ===\n${threadArr.map(c => `- ${c.author || '?'}: "${(c.text || '').substring(0, 200)}"`).join('\n')}\n\nComment của bạn PHẢI bám vào thảo luận đang diễn ra. KHÔNG lặp lại ý đã có. KHÔNG hỏi lại câu đã có người trả lời ở trên.`)
    : ''

  // Determine if this comment should include soft advertising
  const shouldSoftAd = adConfig?.enabled && hasAdOpportunity && Math.random() * 100 < (adConfig.ad_frequency || 30)

  let adDirective = ''
  if (shouldSoftAd) {
    const ctaExamples = {
      question: `"Bạn đã thử ${adConfig.product_name} chưa? Mình dùng thấy khá ổn"`,
      suggestion: `"Nếu cần mình gợi ý ${adConfig.product_name}, mình dùng thấy OK"`,
      experience: `"Mình đang dùng ${adConfig.product_name}, chạy khá mượt cho việc này"`,
    }
    adDirective = `
=== QUẢNG CÁO NHẸ (SOFT MENTION) ===
Bài viết này là CƠ HỘI quảng cáo nhẹ sản phẩm.
Thương hiệu: ${adConfig.brand_name || ''}
Sản phẩm: ${adConfig.product_name}
Mô tả: ${adConfig.product_description || ''}

CÁCH CHÈN — chọn 1 trong các kiểu:
${ctaExamples[adConfig.cta_style] || ctaExamples.experience}

QUY TẮC QUẢNG CÁO NHẸ:
- PHẢI trả lời đúng nội dung bài viết TRƯỚC, rồi mới mention sản phẩm
- Mention tự nhiên như chia sẻ kinh nghiệm cá nhân, KHÔNG quảng cáo lộ liễu
- TUYỆT ĐỐI KHÔNG dùng link, URL, hashtag, số điện thoại
- KHÔNG nói "mua ngay", "liên hệ", "inbox" — chỉ gợi ý nhẹ nhàng
- Nếu bài viết KHÔNG phù hợp để mention → BỎ QUA, comment bình thường
`
  }

  // SAFETY: Skip if no post text — cannot comment without knowing what the post says
  if (!postText || postText.trim().length < 15) {
    console.warn(`[AI-BRAIN] Cannot generate comment: post text too short (${(postText || '').length} chars)`)
    return null
  }

  const langInstr = lang === 'en'
    ? `=== LANGUAGE ===
Write the comment in NATURAL ENGLISH. Use casual, conversational tone like a real group member.`
    : `=== NGÔN NGỮ ===
Viết comment bằng TIẾNG VIỆT TỰ NHIÊN. Giọng casual, slang OK.`

  const prompt = lang === 'en' ? `You are a REAL MEMBER of the Facebook group "${group?.name || ''}". Your comment MUST respond directly to the post content below.

=== POST BY [${postAuthor || '?'}] ===
"${postText.substring(0, 400)}"
${commentAngle ? `\nSUGGESTED ANGLE: ${commentAngle}` : ''}
${threadBlock}
${adDirective}
${langInstr}

=== STRICT RULES ===
1. Comment MUST mention 1 SPECIFIC DETAIL from the post (tech name, number, issue, product mentioned)
2. NEVER write generic comments that could paste into any post
3. If post asks technical question → answer with technical detail (config, command, numbers)
4. If post shares experience → respond to THAT specific experience
5. Write 1-2 sentences, short, casual abbreviations OK
6. AVOID: "I'm also looking into...", "Have you tried X?", "Very useful", "Thanks for sharing"
7. Read the post carefully and respond SPECIFICALLY, don't drift to other topics

GOOD examples:
- Post about Oracle VPS → "Oracle's 24G free tier is solid, been running docker on it smoothly"
- Post about port error → "Check firewall rules, probably blocking 443"
- Post about config → "Change bind_address to 0.0.0.0 in the config, that should work"

BAD examples:
- "I'm also exploring this" ← no specific detail
- "Useful info" ← could paste anywhere
- "Have you tried VPS?" ← unrelated to post

Return ONLY the comment, no explanation.` : `Bạn là THÀNH VIÊN THẬT trong nhóm Facebook "${group?.name || ''}". Comment PHẢI trả lời ĐÚNG nội dung bài viết bên dưới.

=== BÀI VIẾT CỦA [${postAuthor || '?'}] ===
"${postText.substring(0, 400)}"
${commentAngle ? `\nGÓC TIẾP CẬN GỢI Ý: ${commentAngle}` : ''}
${threadBlock}
${adDirective}
${langInstr}

=== QUY TẮC BẮT BUỘC ===
1. Comment PHẢI nhắc đến 1 CHI TIẾT CỤ THỂ từ bài viết (tên công nghệ, con số, vấn đề, sản phẩm được nhắc)
2. KHÔNG ĐƯỢC viết comment chung chung có thể paste vào bất kỳ bài nào
3. Nếu bài hỏi kỹ thuật → trả lời kỹ thuật (config, command, số liệu)
4. Nếu bài chia sẻ kinh nghiệm → phản hồi ĐÚNG kinh nghiệm đó
5. Viết 1-2 câu, ngắn gọn, có thể dùng slang/viết tắt
6. KHÔNG dùng: "Mình cũng đang...", "Bạn đã thử X chưa?", "Rất hay/bổ ích", "Cảm ơn chia sẻ"
7. PHẢI đọc kỹ bài viết và phản hồi CỤ THỂ, KHÔNG lái sang chủ đề khác

VÍ DỤ ĐÚNG (trả lời đúng nội dung):
- Bài hỏi về Oracle VPS → "Oracle 24G free thì ngon, mình chạy docker trên đó mượt lắm"
- Bài lỗi port → "Check firewall rule đi, chắc block port 443 rồi"
- Bài về config → "Sửa dòng bind_address trong config thành 0.0.0.0 là được"

VÍ DỤ SAI (chung chung, copy-paste được):
- "Mình cũng đang tìm hiểu cái này" ← KHÔNG nhắc chi tiết gì
- "Thông tin hữu ích" ← Paste vào bài nào cũng được
- "Bạn thử VPS chưa?" ← Không liên quan nội dung bài

Chỉ trả về COMMENT, không giải thích.`

  try {
    const res = await axios.post(`${API_URL}/ai/generate`, {
      function_name: 'caption_gen',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 120,
      temperature: 0.85,
    }, {
      timeout: 15000,
      headers: headers(ownerId),
    })

    let comment = (res.data?.text || res.data?.result || '').trim()
    if (comment) {
      // Clean up: remove quotes, URLs, excessive length
      comment = comment.replace(/^["']|["']$/g, '').trim()
      comment = comment.replace(/https?:\/\/\S+/gi, '').trim()
      if (comment.length > 150) comment = comment.substring(0, 150).replace(/\s\S*$/, '')

      // REJECT generic comments that don't reference post content
      const genericPatterns = [
        // Vietnamese
        /^mình cũng đang (tìm hiểu|trải nghiệm|sử dụng)/i,
        /^bạn đã thử.*chưa/i,
        /^cảm ơn (bạn )?chia sẻ/i,
        /^thông tin (hữu ích|bổ ích|hay)/i,
        /^rất (hay|bổ ích|hữu ích)/i,
        /^bài viết (hay|rất hay|bổ ích)/i,
        /^mình cũng (nghĩ|thấy) vậy/i,
        /^hay quá/i,
        // English
        /^thanks for sharing/i,
        /^great (post|article|info)/i,
        /^very (useful|helpful|interesting)/i,
        /^i'?m? also (looking|exploring|trying)/i,
        /^have you tried/i,
        /^useful info/i,
        /^nice (post|share)/i,
      ]
      const isGeneric = genericPatterns.some(p => p.test(comment))
      if (isGeneric) {
        console.warn(`[AI-BRAIN] ❌ Rejected generic comment: "${comment.substring(0, 50)}..."`)
        return null // reject → caller skips this post
      }

      if (comment.length >= 5) return { text: comment, ai: true, smart: true }
    }
  } catch (err) {
    console.warn(`[AI-BRAIN] generateSmartComment failed: ${err.message}`)
  }

  return null // null = caller should use fallback
}

/**
 * Scan group posts and save AI scores to DB
 * Separate from commenting — this is the EVALUATION phase
 * Returns scored posts for later use by comment handler
 */
async function scanGroupPosts({ posts, group, campaign, nick, topic, ownerId, adConfig, brandConfig, supabase, campaignId }) {
  if (!posts?.length || !supabase) return []

  // Evaluate all posts via AI
  const evaluated = await evaluatePosts({
    posts, campaign, nick, group, topic,
    maxPicks: posts.length, // score ALL posts
    ownerId, adConfig, brandConfig,
  })

  // Save scores to group_post_scores table
  const ownId = campaign?.owner_id || ownerId
  for (const ev of evaluated) {
    const post = posts[ev.index - 1]
    if (!post) continue

    // Extract fb_post_id from URL
    let fbPostId = null
    if (post.postUrl) {
      const m = post.postUrl.match(/(?:posts|permalink)\/(\d+)/) || post.postUrl.match(/story_fbid=(\d+)/)
      if (m) fbPostId = m[1]
    }
    if (!fbPostId) fbPostId = `unknown_${Date.now()}_${ev.index}`

    try {
      await supabase.from('group_post_scores').upsert({
        owner_id: ownId,
        campaign_id: campaignId,
        fb_group_id: group?.fb_group_id || '',
        group_name: group?.name || '',
        fb_post_id: fbPostId,
        post_url: post.postUrl || null,
        post_author: post.author || '',
        post_text: (post.body || post.text || '').substring(0, 500),
        ai_score: ev.score || 0,
        ad_opportunity: ev.ad_opportunity || false,
        ad_reason: ev.ad_reason || null,
        lead_potential: ev.lead_potential || false,
        comment_angle: ev.comment_angle || null,
        commented: false,
      }, { onConflict: 'owner_id,fb_post_id' })
    } catch {}
  }

  console.log(`[AI-BRAIN] Scanned ${posts.length} posts in "${group?.name}" → ${evaluated.length} scored`)
  return evaluated
}

/**
 * Get best uncommented posts for a campaign (from pre-scanned data)
 * Returns posts sorted by score DESC, not yet commented
 */
async function getBestPosts({ campaignId, fbGroupId, limit, supabase }) {
  if (!supabase || !campaignId) return []

  let query = supabase
    .from('group_post_scores')
    .select('*')
    .eq('campaign_id', campaignId)
    .eq('commented', false)
    .gte('ai_score', 4)
    .order('ai_score', { ascending: false })
    .limit(limit || 5)

  if (fbGroupId) query = query.eq('fb_group_id', fbGroupId)

  const { data } = await query
  return data || []
}

/**
 * Evaluate posts as brand opportunities (for Group Monitor)
 * Unlike evaluatePosts which targets engagement, this focuses on brand keyword relevance
 *
 * @param {Array} posts - Posts from scanGroupPosts
 * @param {Object} opts - { brandKeywords, brandName, threshold, ownerId }
 * @returns {Array} - [{ post, score, reason, matchedKeywords }]
 */
async function evaluateOpportunities(posts, { brandKeywords = [], brandName = '', threshold = 7, ownerId } = {}) {
  if (!posts?.length) return []

  const postList = posts.map((p, i) =>
    `[${i}] ${(p.body || p.text || '').substring(0, 300)}`
  ).join('\n\n')

  const prompt = `Đây là danh sách bài viết trong một Facebook group.
Từ khóa thương hiệu: ${brandKeywords.join(', ')}
${brandName ? `Tên thương hiệu: ${brandName}` : ''}

Đánh giá từng bài: có phù hợp để comment nhẹ liên quan đến thương hiệu không?
Tiêu chí:
- 8-10: Người dùng ĐANG HỎI, TÌM KIẾM, hoặc CẦN TƯ VẤN liên quan đến keyword → CƠ HỘI CAO
- 6-7: Chia sẻ kinh nghiệm, thảo luận liên quan → có thể góp ý tự nhiên
- 4-5: Liên quan gián tiếp
- 1-3: Không liên quan, spam, quảng cáo của người khác → BỎ QUA

KHÔNG phải cơ hội: bài quảng cáo của đối thủ, bài không liên quan, bài chỉ chia sẻ link.

Bài viết:
${postList}

Trả về JSON array, mỗi item:
{
  "index": 0,
  "score": 8,
  "reason": "Người dùng đang hỏi chỗ mua/dùng ... → cơ hội mention tự nhiên",
  "matched_keywords": ["keyword1"]
}

Chỉ include bài có score >= ${threshold}. Nếu không có bài nào, trả [].
Chỉ trả JSON, không giải thích thêm.`

  try {
    const res = await axios.post(`${API_URL}/ai/generate`, {
      function_name: 'relevance_review',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 1500,
      temperature: 0.2,
    }, {
      timeout: 30000,
      headers: headers(ownerId),
    })

    const text = res.data?.content || res.data?.text || res.data?.choices?.[0]?.message?.content || ''
    const jsonMatch = text.match(/\[[\s\S]*\]/)
    if (!jsonMatch) {
      console.warn('[AI-BRAIN] evaluateOpportunities: No JSON array in AI response')
      return []
    }

    const evaluations = JSON.parse(jsonMatch[0])
    return evaluations
      .filter(e => typeof e.index === 'number' && typeof e.score === 'number' && e.score >= threshold)
      .map(e => ({
        post: posts[e.index],
        score: e.score,
        reason: e.reason || '',
        matchedKeywords: e.matched_keywords || [],
      }))
      .filter(e => e.post) // safety: only valid indices
  } catch (err) {
    console.error(`[AI-BRAIN] evaluateOpportunities error: ${err.message}`)
    throw err // let handler do keyword fallback
  }
}

/**
 * Detect the dominant language of a group from a sample of posts.
 * Returns 'vi', 'en', or 'mixed'.
 *
 * Heuristic: count Vietnamese diacritics + common VN words vs English words
 * across all post bodies. Threshold: >60% one side = that language, else mixed.
 */
function detectGroupLanguage(posts) {
  if (!posts?.length) return 'unknown'

  const VI_DIACRITICS = /[àáảãạăắằẳẵặâấầẩẫậèéẻẽẹêếềểễệìíỉĩịòóỏõọôốồổỗộơớờởỡợùúủũụưứừửữựỳýỷỹỵđ]/gi
  const VI_WORDS = /\b(của|này|trong|không|được|những|cái|một|các|có|cho|với|là|tôi|bạn|mình|bài|nhóm|hỏi|cảm ơn|xin|chia sẻ|kinh nghiệm|giúp|sao|gì|thế nào|ạ|ơi|nhé|nhỉ|vậy|rồi|cũng|nhưng|nên|vì|như|hay|tốt|xấu|đang|đã|sẽ|chưa|được|muốn|cần|biết)\b/gi
  const EN_WORDS = /\b(the|of|and|to|in|is|that|for|with|as|are|on|by|this|have|from|or|one|had|but|not|what|all|were|when|we|there|can|your|which|their|will|about|if|out|so|up|my|how|these|its|just|also|been|because|some|then|like|over|new|year|me|us|other|than|now|even|very|may|after|first|much|any|where|every|need|know|use|find|help|good|best)\b/gi
  const CJK = /[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/g

  let viScore = 0, enScore = 0, otherScore = 0
  let totalChars = 0

  for (const p of posts.slice(0, 15)) {
    const text = (p.body || p.text || '').substring(0, 500)
    if (text.length < 20) continue
    totalChars += text.length

    const viDia = (text.match(VI_DIACRITICS) || []).length
    const viW = (text.match(VI_WORDS) || []).length
    const enW = (text.match(EN_WORDS) || []).length
    const cjk = (text.match(CJK) || []).length

    viScore += viDia * 2 + viW * 3 // diacritics are strong vi signal
    enScore += enW * 2
    otherScore += cjk
  }

  if (otherScore > viScore && otherScore > enScore) return 'other'
  if (viScore + enScore < 5) return 'unknown'

  const total = viScore + enScore || 1
  const viRatio = viScore / total
  if (viRatio > 0.6) return 'vi'
  if (viRatio < 0.4) return 'en'
  return 'mixed'
}

/**
 * AI generates answers for Facebook group membership questions.
 * Returns array of { question, answer } pairs.
 */
async function generateMembershipAnswer(questions, groupContext, ownerId) {
  if (!Array.isArray(questions) || questions.length === 0) return []

  const language = groupContext?.language || 'vi'
  const langInstr = language === 'en'
    ? 'Reply naturally in English, like a regular user wanting to join the group.'
    : 'Trả lời tự nhiên bằng tiếng Việt, như người dùng thật muốn tham gia group.'

  const prompt = `Group: ${groupContext?.name || ''}
${groupContext?.topic ? `Chủ đề group: ${groupContext.topic}` : ''}
${groupContext?.description ? `Mô tả: ${groupContext.description.substring(0, 200)}` : ''}

Câu hỏi membership cần trả lời:
${questions.map((q, i) => `${i + 1}. ${q}`).join('\n')}

${langInstr}
- Mỗi câu trả lời tối đa 1-2 câu, ngắn gọn và đúng chủ đề.
- KHÔNG đề cập thương hiệu, sản phẩm cụ thể, link, hay số điện thoại.
- KHÔNG dùng emoji, không viết "Mình rất muốn tham gia group này".
- Nếu hỏi tên/nghề nghiệp → trả lời chung chung kiểu "${language === 'en' ? 'Just a regular user interested in this topic' : 'Mình là người dùng quan tâm đến chủ đề này'}".
- Nếu hỏi sẽ tuân thủ rules không → trả lời "${language === 'en' ? 'Yes, I will follow the group rules' : 'Có, mình sẽ tuân thủ nội quy nhóm'}".

Trả về JSON array (không markdown):
[{"question":"...","answer":"..."}]`

  try {
    const res = await axios.post(`${API_URL}/ai/generate`, {
      function_name: 'caption_gen',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 400,
      temperature: 0.3,
    }, {
      timeout: 12000,
      headers: headers(ownerId),
    })

    const text = res.data?.text || res.data?.result || ''
    const match = text.match(/\[[\s\S]*\]/)
    if (match) {
      const parsed = JSON.parse(match[0])
      if (Array.isArray(parsed)) {
        return parsed
          .filter(p => p.answer && typeof p.answer === 'string')
          .map(p => ({ question: p.question || '', answer: p.answer.trim().slice(0, 250) }))
      }
    }
  } catch (err) {
    console.warn(`[AI-BRAIN] generateMembershipAnswer failed: ${err.message}`)
  }

  // Fallback: generic safe answers
  return questions.map(q => ({
    question: q,
    answer: language === 'en'
      ? 'Yes, I am interested in this topic and will follow the group rules.'
      : 'Mình quan tâm đến chủ đề này và sẽ tuân thủ nội quy nhóm.',
  }))
}

// =====================================================================
// Phase 2: scoreGroup — compute composite score + tier (A/B/C/D)
// Factors: engagement_rate 30% + post_frequency 20% + topic_relevance 30% + language_match 20%
// Inputs:
//   - engagementRate: (likes+comments) / member_count, typical 0.0001..0.05
//   - postsPerDay:    raw posts/day, typical 0..30
//   - topicRelevance: 1..10 (AI score, e.g. ai_join_score)
//   - languageMatch:  boolean (group lang === campaign lang OR campaign='mixed')
// Returns { score: 0..10, tier: 'A'|'B'|'C'|'D' }
// =====================================================================
function scoreGroup({ engagementRate = 0, postsPerDay = 0, topicRelevance = 0, languageMatch = true }) {
  // Normalize each to 0..10
  const engNorm = Math.min(10, (engagementRate || 0) * 1000) // 0.01 → 10
  const freqNorm = Math.min(10, (postsPerDay || 0) / 2)      // 20 posts/day → 10
  const topicNorm = Math.max(0, Math.min(10, topicRelevance || 0))
  const langNorm = languageMatch ? 10 : 0

  const score = engNorm * 0.30 + freqNorm * 0.20 + topicNorm * 0.30 + langNorm * 0.20
  const rounded = Math.round(score * 10) / 10

  let tier = 'D'
  if (rounded >= 8) tier = 'A'
  else if (rounded >= 6) tier = 'B'
  else if (rounded >= 4) tier = 'C'

  return { score: rounded, tier }
}

module.exports = {
  buildContext,
  evaluatePosts,
  qualityGateComment,
  evaluateLeadQuality,
  evaluateProfileForConnect,
  generateSmartComment,
  scanGroupPosts,
  getBestPosts,
  evaluateOpportunities,
  detectGroupLanguage,
  generateMembershipAnswer,
  scoreGroup,
}
