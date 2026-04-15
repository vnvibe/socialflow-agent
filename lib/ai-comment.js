/**
 * AI Comment Generator — calls SocialFlow API to generate contextual comments
 * NEVER uses generic templates — always references the post content
 */

const axios = require('axios')
const hermes = require('./hermes-client')

const API_URL = process.env.API_URL || 'http://localhost:3000'
// Auth priority: AGENT_SECRET_KEY (stable) > SERVICE_ROLE > user JWT (expires)
const SERVICE_KEY = process.env.AGENT_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.AGENT_USER_TOKEN || ''

// Hermes routing — when AGENT_SECRET is set, route through Hermes for comment generation
// (skill-based, self-learning, better quality than generic /ai/comment)
const HERMES_ENABLED = !!process.env.AGENT_SECRET
const AGENT_SECRET = process.env.AGENT_SECRET || ''

async function callHermesComment(payload, accountId) {
  const t0 = Date.now()
  try {
    const res = await axios.post(`${API_URL}/ai-hermes/agent/comment`, payload, {
      timeout: 30000,
      headers: { 'Content-Type': 'application/json', 'X-Agent-Key': AGENT_SECRET },
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
    const res = await axios.post(`${API_URL}/ai-hermes/agent/quality-gate`, payload, {
      timeout: 15000,
      headers: { 'Content-Type': 'application/json', 'X-Agent-Key': AGENT_SECRET },
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
 * Generate a contextual comment using AI
 * If AI API fails, generates a simple contextual comment from post keywords
 * NEVER returns a generic template
 *
 * @param {object} context - { postText, groupName, topic, style, userId }
 * @returns {{ text: string, ai: boolean, reason?: string }}
 */
async function generateComment(context = {}) {
  const { postText, groupName, topic, style, userId, language, accountId } = context

  // Skip if no post text — DON'T comment without context
  if (!postText || postText.length < 10) {
    console.log(`[AI-COMMENT] No post text (${postText?.length || 0} chars), skipping — won't use generic template`)
    return { text: '', ai: false, reason: 'no_post_text' }
  }

  const lang = language === 'en' ? 'en' : 'vi'

  // ── Hermes path (preferred): skill-based with quality gate ──
  if (HERMES_ENABLED) {
    try {
      const hermesResp = await callHermesComment({
        post_snippet: postText,
        group_name: groupName || '',
        topic: topic || '',
        style: style || 'casual',
        language: lang,
      }, accountId)

      let comment = hermesResp?.comment
      if (comment && comment.length > 0) {
        comment = comment.replace(/https?:\/\/\S+/gi, '').trim()
        if (comment.length > 150) comment = comment.substring(0, 150).replace(/\s\S*$/, '').trim()

        if (!comment || comment.length < 10 || /^\.+$/.test(comment)) {
          console.warn(`[AI-COMMENT] Hermes returned broken ("${comment}") — trying legacy API`)
        } else {
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
    const res = await axios.post(`${API_URL}/ai/comment`, {
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
        ...(SERVICE_KEY && { 'Authorization': `Bearer ${SERVICE_KEY}` }),
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
 * Generate a short contextual comment by analyzing post content
 * Extracts key nouns/topics and builds a relevant response
 */
function generateContextualFallback(postText, topic) {
  const lower = postText.toLowerCase()

  // Detect post type and respond accordingly
  // Questions
  if (/\?|ai biết|có ai|mọi người|cho mình hỏi|giúp mình|tư vấn/.test(lower)) {
    const questions = [
      'Mình cũng đang tìm hiểu vấn đề này',
      'Vấn đề hay, mình cũng muốn biết',
      'Câu hỏi đúng lúc mình cũng cần',
    ]
    return pick(questions)
  }

  // Technical/tutorial
  if (/hướng dẫn|cách|setup|cài đặt|config|tutorial|step|bước/.test(lower)) {
    const tech = [
      'Cảm ơn bài hướng dẫn chi tiết',
      'Mình vừa làm theo, rất hữu ích',
      'Bài viết cụ thể và dễ hiểu',
    ]
    return pick(tech)
  }

  // Sharing experience
  if (/kinh nghiệm|trải nghiệm|review|đánh giá|dùng thử|sử dụng/.test(lower)) {
    const exp = [
      'Chia sẻ rất thiết thực',
      'Kinh nghiệm hữu ích cho mình',
      'Mình sẽ thử áp dụng',
    ]
    return pick(exp)
  }

  // Announcement/news
  if (/ra mắt|update|cập nhật|mới|version|release|phiên bản/.test(lower)) {
    const news = [
      'Tin tốt, mình sẽ xem thêm',
      'Cập nhật đáng chú ý',
      'Mình sẽ theo dõi thêm',
    ]
    return pick(news)
  }

  // Problem/error
  if (/lỗi|bug|error|fail|không được|bị|sự cố|crash/.test(lower)) {
    const problem = [
      'Mình cũng gặp tình huống tương tự',
      'Vấn đề này khá phổ biến',
      'Hy vọng sẽ có cách khắc phục sớm',
    ]
    return pick(problem)
  }

  // If topic matches post, reference it
  if (topic) {
    const topicWords = topic.toLowerCase().split(/[\s,]+/).filter(w => w.length > 2)
    const postMatchesTopic = topicWords.some(w => lower.includes(w))
    if (postMatchesTopic) {
      const topicComments = [
        `Chủ đề ${topicWords[0]} này mình cũng quan tâm`,
        `Đang tìm hiểu về ${topicWords[0]}, bài viết đúng lúc`,
        `Mình cũng đang dùng ${topicWords[0]}, chia sẻ hay`,
      ]
      return pick(topicComments)
    }
  }

  // No pattern matched — return empty (don't force a generic comment)
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
  if (HERMES_ENABLED) {
    try {
      const hermesResp = await callHermesComment({
        post_snippet: postContent,
        group_name: '',
        topic: brandName || brandKeywords.join(', '),
        style: 'opportunity',
        language: lang,
        context: `Angle: ${angle}${existingComments.length > 0 ? '. Existing comments (do not repeat): ' + existingComments.slice(0, 3).map(c => `"${(c || '').substring(0, 100)}"`).join(', ') : ''}`,
        brand_config: brandName ? {
          brand_name: brandName,
          brand_description: brandDescription,
          brand_voice: brandVoice || 'casual',
          example_comment: '',
        } : null,
      }, accountId)

      let comment = hermesResp?.comment
      if (comment && comment.length > 0) {
        comment = comment.replace(/https?:\/\/\S+/gi, '').trim()
        if (comment.length > 200) comment = comment.substring(0, 200).replace(/\s\S*$/, '').trim()

        if (!comment || comment.length < 10 || /^\.+$/.test(comment)) {
          console.warn(`[AI-COMMENT] Hermes opportunity broken ("${comment}") — trying legacy`)
        } else {
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

    const brandPrompt = lang === 'en' ? `Post: "${postContent.substring(0, 500)}"
${existingBlock}
Brand: ${brandName}${brandDescription ? ` (${brandDescription})` : ''}
Comment angle: ${angle}
Tone: ${brandVoice || 'natural, friendly, not salesy'}

Write 1 comment as a real user (in NATURAL ENGLISH):
- Answer the post content directly first
- Mention "${brandName}" naturally per the angle: ${angle}
${existingComments.length > 0 ? `- If someone already suggested "${brandName}" → don't repeat, add new info (price, experience, comparison)` : ''}
- Max 2 sentences, max 50 words
- Max 1 emoji
- Don't start with "Oh", "Wow"
- No hashtags, no links, no phone numbers

Return only the comment, no explanation.` : `Bài viết: "${postContent.substring(0, 500)}"
${existingBlock}
Thương hiệu: ${brandName}${brandDescription ? ` (${brandDescription})` : ''}
Góc comment AI đề xuất: ${angle}
Giọng điệu: ${brandVoice || 'tự nhiên, thân thiện, không quảng cáo lộ'}

Viết 1 comment như người dùng thật (TIẾNG VIỆT TỰ NHIÊN):
- Trả lời ĐÚNG vào nội dung bài viết
- Mention "${brandName}" theo góc: ${angle}
${existingComments.length > 0 ? `- Nếu đã có người suggest "${brandName}" → KHÔNG nhắc lại, hãy bổ sung thông tin khác (giá, trải nghiệm, so sánh)` : ''}
- Tối đa 2 câu, tối đa 50 từ
- Không dùng quá 1 emoji
- Không bắt đầu bằng "Ồ", "Wow", "Trời ơi"
- Không có hashtag, không có link, không có số điện thoại

Chỉ trả về comment, không giải thích.`

    const res = await axios.post(`${API_URL}/ai/comment`, {
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
        ...(SERVICE_KEY && { 'Authorization': `Bearer ${SERVICE_KEY}` }),
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

module.exports = { generateComment, generateOpportunityComment }
