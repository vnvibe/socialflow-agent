/**
 * AI Comment Generator — calls SocialFlow API to generate contextual comments
 * NEVER uses generic templates — always references the post content
 */

const axios = require('axios')
const hermes = require('./hermes-client')

const getApiUrl = () => process.env.API_URL || 'http://localhost:3000'
// Auth priority: AGENT_SECRET_KEY (stable) > SERVICE_ROLE > user JWT (expires)
const getServiceKey = () => process.env.AGENT_SECRET_KEY || process.env.AGENT_USER_TOKEN || ''

// Hermes routing — when AGENT_SECRET is set, route through Hermes for comment generation
// (skill-based, self-learning, better quality than generic /ai/comment)
const isHermesEnabled = () => !!process.env.AGENT_SECRET
const getAgentSecret = () => process.env.AGENT_SECRET || ''

/**
 * Categorize post intent into 1 of 4 formal categories
 * @param {string} postContent
 * @returns {'direct' | 'pain_point' | 'use_case' | 'comparison'}
 */
function classifyIntent(postContent = '') {
  if (!postContent) return 'pain_point'
  const text = postContent.toLowerCase()

  if (/\b(mua|thuê|tìm|giá|báo giá|cần vps|cần máy chủ)\b/i.test(text) && /\b(vps|cloud|server|máy chủ)\b/i.test(text)) {
    return 'direct'
  }
  if (/\b(sập|chậm|lag|502|504|quá tải|nghẽn|full cpu|full ram|iops|lỗi|crash|die|bị out)\b/i.test(text)) {
    return 'pain_point'
  }
  if (/\b(treo bot|treo tool|crawl|nuôi nick|nuôi acc|chạy tool|via|proxy|docker|game server|node|telegram bot)\b/i.test(text)) {
    return 'use_case'
  }
  if (/\b(nên dùng|nên chọn|so sánh|hosting hay vps|tư vấn|kinh nghiệm|option nào|loại nào tốt)\b/i.test(text)) {
    return 'comparison'
  }

  return 'pain_point'
}

async function callHermesComment(payload, accountId) {
  const t0 = Date.now()
  try {
    const res = await axios.post(`${getApiUrl()}/ai-hermes/agent/comment`, payload, {
      timeout: 90000,
      headers: { 'Content-Type': 'application/json', 'X-Agent-Key': getAgentSecret() },
    })
    const accTag = accountId ? ` account=${accountId.slice(0, 8)}` : ''
    console.log(`[HERMES] task=comment_gen${accTag} → OK (${Date.now() - t0}ms)`)
    return res.data
  } catch (err) {
    const accTag = accountId ? ` account=${accountId.slice(0, 8)}` : ''
    console.warn(`[HERMES] task=comment_gen${accTag} → FAIL (${err.message})`)
    throw err
  }
}

async function callHermesQualityGate(payload, accountId) {
  const t0 = Date.now()
  try {
    const res = await axios.post(`${getApiUrl()}/ai-hermes/agent/quality-gate`, payload, {
      timeout: 30000,
      headers: { 'Content-Type': 'application/json', 'X-Agent-Key': getAgentSecret() },
    })
    const accTag = accountId ? ` account=${accountId.slice(0, 8)}` : ''
    console.log(`[HERMES] task=quality_gate${accTag} → OK (${Date.now() - t0}ms, score=${res.data?.score ?? '?'})`)
    return res.data
  } catch (err) {
    const accTag = accountId ? ` account=${accountId.slice(0, 8)}` : ''
    console.warn(`[HERMES] task=quality_gate${accTag} → FAIL (${err.message})`)
    throw err
  }
}

/**
 * Validate that generated comment does NOT echo or repeat original post text
 * @param {string} comment - Generated comment text
 * @param {string} postSnippet - Original post snippet
 * @returns {{ valid: boolean, reason?: string }}
 */
function validateCommentNotEcho(comment, postSnippet) {
  if (!comment || !postSnippet) return { valid: true }

  const normComment = comment.toLowerCase().trim()
  const normPost = postSnippet.toLowerCase().trim()

  // 1. Check for explicit prompt echo markers
  const echoMarkers = ['bài viết gốc', '--- bài viết', '```', 'post_snippet', 'post text:', 'bài viết:']
  for (const marker of echoMarkers) {
    if (normComment.includes(marker)) {
      return { valid: false, reason: `contains_echo_marker:${marker}` }
    }
  }

  // 2. Check for verbatim long substring inclusion (>25 chars)
  if (normPost.length >= 20) {
    const postSlice = normPost.substring(0, Math.min(30, normPost.length))
    if (normComment.includes(postSlice)) {
      return { valid: false, reason: 'contains_post_substring_echo' }
    }
  }

  // 3. Jaccard word-overlap similarity check (>45% copy of post words)
  const commentWords = normComment.replace(/[^\w\sàáảãạâầấẩẫậăằắẳẵặèéẻẽẹêềếểễệđìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵ]/gi, '').split(/\s+/).filter(w => w.length > 2)
  const postWords = normPost.replace(/[^\w\sàáảãạâầấẩẫậăằắẳẵặèéẻẽẹêềếểễệđìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵ]/gi, '').split(/\s+/).filter(w => w.length > 2)

  if (commentWords.length >= 5 && postWords.length >= 5) {
    const commentSet = new Set(commentWords)
    const postSet = new Set(postWords)
    let intersection = 0
    for (const w of commentSet) {
      if (postSet.has(w)) intersection++
    }
    const similarity = intersection / commentSet.size
    if (similarity > 0.45) {
      return { valid: false, reason: `high_word_overlap_similarity:${(similarity * 100).toFixed(0)}%` }
    }
  }

  return { valid: true }
}

/**
 * Generate a contextual comment using AI
 * If AI API fails, generates a simple contextual comment from post keywords
 * NEVER returns a generic template
 *
 * @param {object} context - { postText, groupName, topic, style, userId }
 * @returns {{ text: string, ai: boolean, reason?: string }}
 */
async function generateComment(context = {}) {
  const { postText, groupName, topic, style, userId, language, accountId, campaignId, groupFbId } = context

  // Skip if no post text — DON'T comment without context
  if (!postText || postText.length < 10) {
    console.log(`[AI-COMMENT] No post text (${postText?.length || 0} chars), skipping — won't use generic template`)
    return { text: '', ai: false, reason: 'no_post_text' }
  }

  const lang = language === 'en' ? 'en' : 'vi'

  // ── Hermes path (preferred): skill-based with quality gate ──
  if (isHermesEnabled()) {
    try {
      const hermesResp = await callHermesComment({
        post_snippet: postText,
        group_name: groupName || '',
        topic: topic || '',
        style: style || 'casual',
        language: lang,
        account_id: accountId,
        campaign_id: campaignId,
        group_fb_id: groupFbId,
      }, accountId)

      let comment = hermesResp?.comment
      if (comment && comment.length > 0) {
        comment = comment.replace(/https?:\/\/\S+/gi, '').trim()
        if (comment.length > 150) comment = comment.substring(0, 150).replace(/\s\S*$/, '').trim()

        if (!comment || comment.length < 10 || /^\.+$/.test(comment)) {
          console.warn(`[AI-COMMENT] Hermes returned broken ("${comment}") — trying legacy API`)
        } else {
          // Echo / Verbatim validation check
          const echoCheck = validateCommentNotEcho(comment, postText)
          if (!echoCheck.valid) {
            console.warn(`[AI-COMMENT] REJECTED echo/verbatim repetition (${echoCheck.reason}): "${comment.substring(0, 60)}"`)
            hermes.sendFeedback({
              taskType: 'comment_gen', outputText: comment, score: 1,
              accountId, reason: `echo_rejected: ${echoCheck.reason}`,
            })
            return { text: '', ai: false, reason: `echo_rejected:${echoCheck.reason}` }
          }

          // Quality gate check — don't post generic/bad comments
          try {
            const gate = await callHermesQualityGate({
              comment,
              post_snippet: postText,
              language: lang,
            }, accountId)
            if (gate && gate.pass === false) {
              console.warn(`[AI-COMMENT] Hermes quality gate REJECTED (score ${gate.score}): ${gate.reason}`)
              // Negative feedback — output was rejected
              hermes.sendFeedback({
                taskType: 'comment_gen', outputText: comment, score: 2,
                accountId, reason: `quality_rejected: ${gate.reason}`,
              })
              return { text: '', ai: false, reason: `quality_gate_rejected:${gate.reason?.substring(0, 80) || 'unknown'}` }
            }
            console.log(`[AI-COMMENT] Hermes ✓ (quality ${gate?.score || '?'}/10)`)
            // Positive feedback — passed quality gate
            hermes.sendFeedback({
              taskType: 'comment_gen', outputText: comment, score: Math.max(3, Math.min(5, Math.round((gate?.score || 7) / 2))),
              accountId, reason: 'quality_gate_passed',
            })
          } catch (gateErr) {
            // Quality gate failure shouldn't block the comment
            console.warn(`[AI-COMMENT] Quality gate error: ${gateErr.message} — accepting anyway`)
          }
          return { text: comment, ai: true, source: 'hermes' }
        }
      }
    } catch (err) {
      console.warn(`[AI-COMMENT] Hermes failed (${err.message}) — falling back to legacy /ai/comment`)
    }
  }

  // ── Legacy path (fallback): /ai/comment with DeepSeek orchestrator ──
  try {
    const res = await axios.post(`${getApiUrl()}/ai/comment`, {
      post_snippet: postText,
      group_name: groupName || '',
      topic: topic || '',
      style: style || 'casual',
      language: lang,
      user_id: userId || null,
    }, {
      timeout: 15000,
      headers: {
        'Content-Type': 'application/json',
        ...(getServiceKey() && { 'Authorization': `Bearer ${getServiceKey()}` }),
      },
    })

    let comment = res.data?.comment
    if (comment && comment.length > 0) {
      // Filter: remove URLs (FB blocks from new accounts)
      comment = comment.replace(/https?:\/\/\S+/gi, '').trim()
      // Truncate for nurture (keep short and natural) — cut at last word boundary, NO ellipsis
      if (comment.length > 150) comment = comment.substring(0, 150).replace(/\s\S*$/, '').trim()
      // Reject if still looks broken or too short
      if (!comment || comment.length < 10 || comment === '...' || /^\.+$/.test(comment)) {
        console.warn(`[AI-COMMENT] Comment too short/broken after filter ("${comment}") — skipping`)
        return { text: '', ai: false, reason: 'comment_too_short' }
      }
      return { text: comment, ai: true, source: 'legacy' }
    }
    console.warn(`[AI-COMMENT] AI returned empty — falling back to contextual`)
  } catch (err) {
    console.warn(`[AI-COMMENT] API failed (${err.message}) — falling back to contextual`)
  }

  // Fallback: generate contextual comment from post content (NOT generic template)
  const contextual = generateContextualFallback(postText, topic)
  if (contextual) {
    return { text: contextual, ai: false, reason: 'contextual_fallback' }
  }

  // Last resort: return empty — caller should skip this post, NOT use a template
  return { text: '', ai: false, reason: 'no_suitable_comment' }
}

/**
 * Contextual fallback — DISABLED (2026-05-08)
 *
 * Previous implementation used hardcoded templates like:
 *   "Mình cũng đang tìm hiểu vấn đề này"
 *   "Chia sẻ rất thiết thực"
 *   "Kinh nghiệm hữu ích cho mình"
 *
 * These are EXACTLY the patterns quality_gate rejects as generic/bot-like
 * (see ai-brain.js genericPatterns). Using them creates a paradox:
 *   AI fail → fallback generates template → quality gate rejects template → 0 output
 *
 * New behavior: return empty → caller skips this post → no spam comment.
 * Quality > quantity. A skipped post is always better than a bot-flagged comment.
 */
function generateContextualFallback(/* postText, topic */) {
  return ''
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)]
}

/**
 * Generate an opportunity-aware comment with brand context
 * Used by campaign-opportunity-react handler
 *
 * @param {object} opts - { postContent, brandName, brandDescription, brandVoice, commentAngle, existingComments, userId }
 *                       Legacy: brandKeywords, opportunityReason still accepted but ignored if commentAngle present
 * @returns {{ text: string, ai: boolean, reason?: string }}
 */
async function generateOpportunityComment({
  postContent,
  brandName = '',
  brandDescription = '',
  brandVoice = '',
  commentAngle = '',
  existingComments = [],
  language = 'vi',
  userId,
  accountId,
  campaignId,
  groupFbId,
  matchedProduct = null, // specific matched product/plan
  // legacy fields — backward compat
  brandKeywords = [],
  opportunityReason = '',
} = {}) {
  if (!postContent || postContent.length < 10) {
    return { text: '', ai: false, reason: 'no_post_content' }
  }

  const lang = language === 'en' ? 'en' : 'vi'
  const angle = commentAngle || opportunityReason || (lang === 'en' ? 'natural suggestion for someone asking' : 'gợi ý tự nhiên cho người đang hỏi')

  // ── Hermes path (brand-aware comment with quality gate) ──
  if (isHermesEnabled()) {
    try {
      // Merge specific matched product info into the brand description context
      const brandDescMerged = matchedProduct
        ? `[Sản phẩm/Gói cước cần gợi ý: ${matchedProduct.name} - Mô tả: ${matchedProduct.description || ''}]. ${brandDescription}`
        : brandDescription

      const hermesResp = await callHermesComment({
        post_snippet: postContent,
        group_name: '',
        topic: brandName || brandKeywords.join(', '),
        style: 'opportunity',
        language: lang,
        context: `Angle: ${angle}${existingComments.length > 0 ? '. Existing comments (do not repeat): ' + existingComments.slice(0, 3).map(c => `"${(c || '').substring(0, 100)}"`).join(', ') : ''}`,
        brand_config: brandName ? {
          brand_name: brandName,
          brand_description: brandDescMerged,
          brand_voice: brandVoice || 'casual',
          example_comment: '',
        } : null,
        account_id: accountId,
        campaign_id: campaignId,
        group_fb_id: groupFbId,
      }, accountId)

      let comment = hermesResp?.comment
      if (comment && comment.length > 0) {
        comment = comment.replace(/https?:\/\/\S+/gi, '').trim()
        if (comment.length > 200) comment = comment.substring(0, 200).replace(/\s\S*$/, '').trim()

        if (!comment || comment.length < 10 || /^\.+$/.test(comment)) {
          console.warn(`[AI-COMMENT] Hermes opportunity broken ("${comment}") — trying legacy`)
        } else {
          // Echo / Verbatim validation check
          const echoCheck = validateCommentNotEcho(comment, postContent)
          if (!echoCheck.valid) {
            console.warn(`[AI-COMMENT] REJECTED opportunity echo/verbatim repetition (${echoCheck.reason}): "${comment.substring(0, 60)}"`)
            hermes.sendFeedback({
              taskType: 'comment_gen', outputText: comment, score: 1,
              accountId, reason: `opportunity_echo_rejected: ${echoCheck.reason}`,
            })
            return { text: '', ai: false, reason: `opportunity_echo_rejected:${echoCheck.reason}` }
          }

          // Quality gate for opportunity comments (stricter — brand mentions must look natural)
          try {
            const gate = await callHermesQualityGate({
              comment,
              post_snippet: postContent,
              language: lang,
            }, accountId)
            if (gate && gate.pass === false) {
              console.warn(`[AI-COMMENT] Hermes opportunity quality REJECTED (score ${gate.score}): ${gate.reason}`)
              hermes.sendFeedback({
                taskType: 'comment_gen', outputText: comment, score: 2,
                accountId, reason: `opportunity_rejected: ${gate.reason}`,
              })
              return { text: '', ai: false, reason: `quality_gate_rejected:${gate.reason?.substring(0, 80) || 'unknown'}` }
            }
            console.log(`[AI-COMMENT] Hermes opportunity ✓ (quality ${gate?.score || '?'}/10)`)
          } catch (gateErr) {
            console.warn(`[AI-COMMENT] Opportunity quality gate error: ${gateErr.message} — accepting`)
          }
          return { text: comment, ai: true, source: 'hermes' }
        }
      }
    } catch (err) {
      console.warn(`[AI-COMMENT] Hermes opportunity failed (${err.message}) — falling back to legacy`)
    }
  }

  // Try AI first — with brand-specific prompt that uses commentAngle from AI eval
  try {
    const existingBlock = existingComments.length > 0
      ? (lang === 'en'
          ? `\nExisting comments:\n${existingComments.slice(0, 5).map(c => `- "${(c || '').substring(0, 150)}"`).join('\n')}\n`
          : `\nComments hiện có:\n${existingComments.slice(0, 5).map(c => `- "${(c || '').substring(0, 150)}"`).join('\n')}\n`)
      : ''

    const productSegment = matchedProduct ? `Specific Product/Plan to suggest: "${matchedProduct.name}" — Description: ${matchedProduct.description || ''}` : ''
    const mentionTarget = matchedProduct ? `"${matchedProduct.name}" (a product of ${brandName})` : `"${brandName}"`

    const brandPrompt = lang === 'en' ? `Post: "${postContent.substring(0, 500)}"
${existingBlock}
Brand: ${brandName}${brandDescription ? ` (${brandDescription})` : ''}
${productSegment ? `${productSegment}\n` : ''}Comment angle: ${angle}
Tone: ${brandVoice || 'natural, friendly, not salesy'}

Write 1 comment as a real user (in NATURAL ENGLISH):
- Answer the post content directly first
- Suggest/Mention ${mentionTarget} naturally per the angle: ${angle}
${existingComments.length > 0 ? `- If someone already suggested ${mentionTarget} → don't repeat, add new info (price, experience, comparison)` : ''}
- Max 2 sentences, max 50 words
- Max 1 emoji
- Don't start with "Oh", "Wow"
- No hashtags, no links, no phone numbers

Return only the comment, no explanation.` : `Bài viết: "${postContent.substring(0, 500)}"
${existingBlock}
Thương hiệu: ${brandName}${brandDescription ? ` (${brandDescription})` : ''}
${productSegment ? `Sản phẩm/Gói cước cụ thể cần gợi ý: "${matchedProduct.name}" — Mô tả: ${matchedProduct.description || ''}\n` : ''}Góc comment AI đề xuất: ${angle}
Giọng điệu: ${brandVoice || 'tự nhiên, thân thiện, khách quan, giàu kiến thức thực tế'}

Viết 1 comment chia sẻ kinh nghiệm khách quan (TIẾNG VIỆT TỰ NHIÊN):
- ĐÓNG VAI: Một Kỹ sư hệ thống (System Engineer) / DevOps nhiều năm kinh nghiệm, đang thảo luận chuyên môn. Giọng điệu khách quan, trung tính, đáng tin cậy.
- QUY TẮC VÀNG 80/20 (BẮT BUỘC):
  + 80% nội dung (câu đầu + chẩn đoán): Tập trung hoàn toàn vào việc phân tích lỗi kỹ thuật, chẩn đoán ngắt nghẽn RAM/CPU/IOPS, trả lời trực tiếp thắc mắc hoặc tư vấn cấu hình kỹ thuật cụ thể theo đúng ngữ cảnh bài viết. Dùng ngôn ngữ kỹ thuật tự nhiên (e.g. "bác", "thớt", "nginx log", "vps", "docker", "port", "mượt re", "cài").
  + 20% nội dung (câu cuối): Đề xuất/Nhắc tới ${mentionTarget} một cách cực kỳ khéo léo, khách quan dưới dạng chia sẻ giải pháp/trải nghiệm cá nhân thực tế.
- MẪU THAM CHIẾU CHUẨN (HỌC THEO PHONG CÁCH NÀY):
  * Mẫu 1 (Pain-Point): "Bác thử kiểm tra log nginx trước xem bị nghẽn IOPS hay RAM. Nếu do lượng truy cập tăng thì chuyển từ Shared Hosting qua Cloud VPS chạy Docker hoặc LiteSpeed là mượt ngay. Bên Tino VPS dùng SSD NVMe chạy khá ổn định đó bác."
  * Mẫu 2 (Use-Case): "Treo bot Telegram 24/7 thì bác nên thuê con VPS Windows/Linux loại nhỏ tầm 50-100k/tháng là chạy vi vu rồi, khỏi lo tắt máy nhà. Mình đang treo bên Tino VPS vài tháng nay mượt re."
- TUYỆT ĐỐI CẤM dùng định dạng Markdown (như bôi đậm **, in nghiêng *). Không dùng dấu ngoặc kép bọc tên thương hiệu hay sản phẩm.
- HẠN CHẾ TỐI ĐA emoji. Tuyệt đối không dùng các emoji của AI bán hàng (😊, ✨, 🚀, 👍).
- ${existingComments.length > 0 ? `- Nếu đã có người suggest ${mentionTarget} → KHÔNG nhắc lại, hãy bổ sung thông tin kỹ thuật khác (giá, trải nghiệm chịu tải thực tế, so sánh)` : ''}
- Tối đa 2 câu, tối đa 55 từ.
- Không bắt đầu bằng "Ồ", "Wow", "Trời ơi", "Tuyệt vời", "Cảm ơn đã chia sẻ".
- Không có hashtag, không có link, không có số điện thoại.

Chỉ trả về comment, không giải thích.`

    const res = await axios.post(`${getApiUrl()}/ai/comment`, {
      post_snippet: postContent,
      group_name: '',
      topic: brandName || brandKeywords.join(', '),
      style: 'opportunity',
      language: lang,
      user_id: userId || null,
      custom_prompt: brandPrompt,
    }, {
      timeout: 15000,
      headers: {
        'Content-Type': 'application/json',
        ...(getServiceKey() && { 'Authorization': `Bearer ${getServiceKey()}` }),
      },
    })

    let comment = res.data?.comment
    if (comment && comment.length > 0) {
      // Filter URLs
      comment = comment.replace(/https?:\/\/\S+/gi, '').trim()
      // Truncate at last word boundary, NO ellipsis appended
      if (comment.length > 200) comment = comment.substring(0, 200).replace(/\s\S*$/, '').trim()
      // Reject if too short or just dots
      if (!comment || comment.length < 10 || comment === '...' || /^\.+$/.test(comment)) {
        console.warn(`[AI-COMMENT] Opportunity comment too short/broken ("${comment}") — skipping`)
        return { text: '', ai: false, reason: 'opportunity_too_short' }
      }
      return { text: comment, ai: true }
    }
    console.warn('[AI-COMMENT] Opportunity AI returned empty — falling back to contextual')
  } catch (err) {
    console.warn(`[AI-COMMENT] Opportunity API failed (${err.message}) — falling back`)
  }

  // Contextual fallback with brand awareness
  const contextual = generateBrandContextualFallback(postContent, brandKeywords, brandName)
  if (contextual) {
    return { text: contextual, ai: false, reason: 'brand_contextual_fallback' }
  }

  return { text: '', ai: false, reason: 'no_suitable_opportunity_comment' }
}

/**
 * Generate brand-aware contextual fallback when AI fails
 */
function generateBrandContextualFallback(postContent, brandKeywords = [], brandName = '') {
  const lower = postContent.toLowerCase()

  // Check if post is a question
  if (/\?|ai biết|có ai|mọi người|cho mình hỏi|giúp mình|tư vấn|ở đâu|chỗ nào/.test(lower)) {
    if (brandName) {
      const templates = [
        `Mình thấy ${brandName} cũng được nhiều người recommend đó bạn`,
        `Bạn thử tìm hiểu ${brandName} xem, mình dùng thấy ổn`,
        `${brandName} cũng là một option hay, bạn tham khảo thử`,
      ]
      return templates[Math.floor(Math.random() * templates.length)]
    }
    return null // no brand name = can't do meaningful fallback
  }

  // Experience sharing
  if (/kinh nghiệm|chia sẻ|review|đánh giá|so sánh/.test(lower)) {
    if (brandName) {
      return `Cảm ơn bạn chia sẻ, mình cũng có trải nghiệm tương tự với ${brandName}`
    }
  }

  return null // don't force a generic comment
}

module.exports = { generateComment, generateOpportunityComment, classifyIntent }
