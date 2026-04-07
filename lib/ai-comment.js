/**
 * AI Comment Generator — calls SocialFlow API to generate contextual comments
 * NEVER uses generic templates — always references the post content
 */

const axios = require('axios')

const API_URL = process.env.API_URL || 'http://localhost:3000'
// Auth priority: AGENT_SECRET_KEY (stable) > SERVICE_ROLE > user JWT (expires)
const SERVICE_KEY = process.env.AGENT_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.AGENT_USER_TOKEN || ''

/**
 * Generate a contextual comment using AI
 * If AI API fails, generates a simple contextual comment from post keywords
 * NEVER returns a generic template
 *
 * @param {object} context - { postText, groupName, topic, style, userId }
 * @returns {{ text: string, ai: boolean, reason?: string }}
 */
async function generateComment(context = {}) {
  const { postText, groupName, topic, style, userId } = context

  // Skip if no post text — DON'T comment without context
  if (!postText || postText.length < 10) {
    console.log(`[AI-COMMENT] No post text (${postText?.length || 0} chars), skipping — won't use generic template`)
    return { text: '', ai: false, reason: 'no_post_text' }
  }

  // Try AI first
  try {
    const res = await axios.post(`${API_URL}/ai/comment`, {
      post_snippet: postText,
      group_name: groupName || '',
      topic: topic || '',
      style: style || 'casual',
      language: 'vi',
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
      // Truncate for nurture (keep short and natural)
      if (comment.length > 150) comment = comment.substring(0, 150).replace(/\s\S*$/, '...')
      if (comment.length > 0) {
        return { text: comment, ai: true }
      }
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
  userId,
  // legacy fields — backward compat
  brandKeywords = [],
  opportunityReason = '',
} = {}) {
  if (!postContent || postContent.length < 10) {
    return { text: '', ai: false, reason: 'no_post_content' }
  }

  const angle = commentAngle || opportunityReason || 'gợi ý tự nhiên cho người đang hỏi'

  // Try AI first — with brand-specific prompt that uses commentAngle from AI eval
  try {
    const existingBlock = existingComments.length > 0
      ? `\nComments hiện có:\n${existingComments.slice(0, 5).map(c => `- "${(c || '').substring(0, 150)}"`).join('\n')}\n`
      : ''

    const brandPrompt = `Bài viết: "${postContent.substring(0, 500)}"
${existingBlock}
Thương hiệu: ${brandName}${brandDescription ? ` (${brandDescription})` : ''}
Góc comment AI đề xuất: ${angle}
Giọng điệu: ${brandVoice || 'tự nhiên, thân thiện, không quảng cáo lộ'}

Viết 1 comment như người dùng thật:
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
      language: 'vi',
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
      // Truncate
      if (comment.length > 200) comment = comment.substring(0, 200).replace(/\s\S*$/, '...')
      if (comment.length > 5) {
        return { text: comment, ai: true }
      }
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
