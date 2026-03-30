/**
 * AI Comment Generator — calls SocialFlow API to generate contextual comments
 * Falls back to expanded templates if API is unavailable
 */

const axios = require('axios')

const API_URL = process.env.API_URL || process.env.RAILWAY_URL || 'https://socialflow-production.up.railway.app'
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || ''

// Expanded templates — 30+ options to avoid repetition detection
const FALLBACK_TEMPLATES = {
  generic: [
    'Hay quá! 👍',
    'Cảm ơn bạn chia sẻ',
    'Thông tin hữu ích',
    'Mình cũng nghĩ vậy',
    'Bài viết hay!',
    'Hữu ích quá',
    'Thanks bạn',
    'Hay lắm',
    'Bài viết rất bổ ích',
    'Mình đã lưu bài này',
  ],
  agreement: [
    'Đúng vậy',
    'Đồng ý 💯',
    'Mình đồng ý',
    'Chính xác',
    'Chuẩn luôn',
    'Đúng rồi bạn',
  ],
  question: [
    'Bạn có thể chia sẻ thêm không?',
    'Mình muốn tìm hiểu thêm',
    'Có ai thử chưa ạ?',
    'Cho mình hỏi thêm được không?',
  ],
  emoji: [
    '👍',
    '💯',
    '🔥',
    '❤️',
    '👏',
    '🙏',
  ],
  short: [
    'Nice!',
    'Tuyệt',
    'Good',
    'Hay',
    'Ok',
    'Noted',
  ],
}

// Flatten all templates for random pick
const ALL_TEMPLATES = Object.values(FALLBACK_TEMPLATES).flat()

/**
 * Generate a contextual comment using AI, with template fallback
 * @param {object} context - { postText, groupName, topic, style, userId, templates }
 * @returns {string} comment text
 */
async function generateComment(context = {}) {
  const { postText, groupName, topic, style, userId } = context

  // Skip AI if no post text to work with
  if (!postText || postText.length < 10) {
    const text = pickTemplate(context.templates, topic)
    console.log(`[AI-COMMENT] No post text (${postText?.length || 0} chars), using template`)
    return { text, ai: false, reason: 'no_post_text' }
  }

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
    console.warn(`[AI-COMMENT] AI returned empty comment, using template`)
  } catch (err) {
    console.warn(`[AI-COMMENT] API failed (${err.message}), using template`)
  }

  const text = pickTemplate(context.templates, topic)
  return { text, ai: false, reason: 'api_failed' }
}

/**
 * Pick a template, optionally weighted by topic
 */
function pickTemplate(custom, topic) {
  if (custom?.length) {
    return custom[Math.floor(Math.random() * custom.length)]
  }

  // 40% chance emoji/short for natural feel, 60% full comment
  const roll = Math.random()
  if (roll < 0.15) {
    return pick(FALLBACK_TEMPLATES.emoji)
  }
  if (roll < 0.30) {
    return pick(FALLBACK_TEMPLATES.short)
  }
  if (roll < 0.45) {
    return pick(FALLBACK_TEMPLATES.agreement)
  }
  if (roll < 0.55) {
    return pick(FALLBACK_TEMPLATES.question)
  }
  return pick(FALLBACK_TEMPLATES.generic)
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)]
}

module.exports = { generateComment, FALLBACK_TEMPLATES, ALL_TEMPLATES }
