/**
 * feed-ad-strategy.js — Quyết định MỖI BÀI: cài quảng cáo hay comment như user thường.
 *
 * Nguyên tắc cốt lõi: ĐA SỐ comment phải là organic.
 * Nick nào cũng cài quảng cáo vào mọi bài là mẫu hình spam kinh điển — Facebook
 * bắt được, và người thật đọc cũng thấy giả. Vì vậy quảng cáo bị chặn 3 tầng:
 *   1. Trần cứng/ngày (daily_ad_comments) — luôn nhỏ hơn tổng comment/ngày
 *   2. Ngưỡng điểm cơ hội (ad_min_score) — bài phải thật sự liên quan sản phẩm
 *   3. Bài nhạy cảm / hỏi-đáp không hợp bán hàng → luôn organic
 *
 * Pure function, không đụng DB/DOM — test offline được.
 * Khớp với vốn từ sẵn có của ai-brain: ad_strategy ∈ pitch|recommend|seed|organic.
 */

const { stripDiacritics } = require('./feed-filter')

// Bài mang các dấu hiệu này thì KHÔNG cài quảng cáo dù khớp từ khoá sản phẩm.
// Chèn quảng cáo vào đây vừa phản cảm vừa dễ ăn report.
const NO_AD_SIGNALS = [
  'chia buon', 'tang le', 'tai nan', 'benh', 'cap cuu', 'mat tich',
  'lua dao', 'bao cao', 'to cao', 'khieu nai', 'toi te', 'that vong',
  'tuyen dung', 'tim viec', 'ban acc', 'cho thue lai',
].map(stripDiacritics)

/**
 * Tìm sản phẩm khớp nội dung bài.
 * products: [{name, keywords: [], pitch}]
 * @returns {{product, hits}|null}
 */
function matchProduct(text, products = []) {
  const norm = stripDiacritics(text)
  let best = null
  for (const p of products) {
    if (!p || !p.name) continue
    const kws = (p.keywords || []).map(stripDiacritics).filter(Boolean)
    const hits = kws.filter(k => norm.includes(k))
    if (hits.length && (!best || hits.length > best.hits.length)) {
      best = { product: p, hits }
    }
  }
  return best
}

/** Bài có dấu hiệu không hợp quảng cáo? */
function hasNoAdSignal(text) {
  const norm = stripDiacritics(text)
  return NO_AD_SIGNALS.find(s => norm.includes(s)) || null
}

/**
 * Trần quảng cáo/ngày cho nick.
 *   - Số cụ thể (daily_ad_comments hữu hạn) → dùng đúng số đó.
 *   - null / không đặt → AUTO: nới theo tuổi nick. Nick non tuổi thấp giữ
 *     trần thấp cho an toàn; nick già cho nhiều cơ hội đúng hơn. Vẫn bị cổng
 *     chất lượng chặn nên không thành spam.
 */
function autoAdCap(nickAge) {
  if (!Number.isFinite(nickAge)) return 3
  if (nickAge < 14) return 2
  if (nickAge < 30) return 4
  if (nickAge < 90) return 6
  return 8
}
function capForNiche(niche, nickAge) {
  return Number.isFinite(niche.daily_ad_comments)
    ? niche.daily_ad_comments
    : autoAdCap(nickAge)   // null/undefined → auto theo tuổi
}

/**
 * Quyết định chiến lược comment cho 1 bài.
 *
 * @param {object} post   { text, ... }
 * @param {object} niche  cấu hình nick (ad_enabled, products, daily_ad_comments,
 *                         ad_min_score, ad_style, brand_name...)
 * @param {object} usage  { adCommentsToday } — đã cài quảng cáo mấy lần hôm nay
 * @param {object} aiEval kết quả chấm điểm AI (tuỳ chọn):
 *                         { ad_opportunity: bool, ad_score: 0-10, matched_product_name }
 * @returns {{
 *   strategy: 'organic'|'seed'|'recommend'|'pitch',
 *   isAd: boolean,
 *   product: object|null,
 *   score: number,
 *   reason: string
 * }}
 */
function decideAdStrategy(post, niche = {}, usage = {}, aiEval = null) {
  const text = (post && post.text) || ''
  const organic = (reason) => ({ strategy: 'organic', isAd: false, product: null, score: 0, reason })

  // 1. Tắt quảng cáo cho nick này
  if (!niche.ad_enabled) return organic('ad_disabled')

  // 2. Trần quảng cáo/ngày. daily_ad_comments = null → AUTO: trần tự nới theo
  //    tuổi nick (nick già an toàn hơn nên cho chèn nhiều cơ hội đúng hơn).
  //    Cổng chất lượng bên dưới (điểm ≥ ad_min_score + khớp sản phẩm) mới là
  //    thứ quyết định bài nào đáng chèn — trần chỉ là lưới an toàn.
  const cap = capForNiche(niche, usage.nickAge)
  const used = usage.adCommentsToday || 0
  if (used >= cap) return organic(`ad_quota_reached:${used}/${cap}`)

  // 3. Bài nhạy cảm / không hợp bán hàng
  const bad = hasNoAdSignal(text)
  if (bad) return organic(`no_ad_signal:${bad}`)

  // 4. Phải khớp sản phẩm cụ thể — không khớp thì không có gì để nói
  const m = matchProduct(text, niche.products || [])
  if (!m) return organic('no_product_match')

  // 5. Điểm cơ hội: ưu tiên điểm AI, thiếu thì suy từ số từ khoá khớp
  const minScore = Number.isFinite(niche.ad_min_score) ? niche.ad_min_score : 7
  const score = (aiEval && Number.isFinite(aiEval.ad_score))
    ? aiEval.ad_score
    : Math.min(10, 4 + m.hits.length * 2)   // 1 từ khoá=6, 2=8, 3+=10
  if (score < minScore) return organic(`score_below_min:${score}<${minScore}`)

  // 6. AI nói rõ đây KHÔNG phải cơ hội → tôn trọng, comment organic
  if (aiEval && aiEval.ad_opportunity === false) return organic('ai_says_not_opportunity')

  // Được cài quảng cáo. 'soft' = gợi ý như user thật (mặc định, an toàn hơn),
  // 'direct' = nêu tên sản phẩm rõ ràng.
  const strategy = niche.ad_style === 'direct' ? 'recommend' : 'seed'
  return {
    strategy,
    isAd: true,
    product: m.product,
    score,
    reason: `matched:${m.product.name}(${m.hits.join(',')})`,
  }
}

/**
 * Dựng tham số truyền cho ai-brain.generateSmartComment.
 * Giữ nguyên vốn từ sẵn có để không phải sửa ai-brain.
 */
function buildCommentParams(decision, niche = {}) {
  if (!decision.isAd) {
    return {
      adStrategy: 'organic',
      hasAdOpportunity: false,
      matchedProduct: null,
      brandConfig: null,   // organic: KHÔNG bơm brand vào prompt, tránh lỡ miệng
    }
  }
  return {
    adStrategy: decision.strategy,
    hasAdOpportunity: true,
    matchedProduct: decision.product,
    brandConfig: {
      brand_name: niche.brand_name || null,
      brand_description: niche.brand_description || null,
      style: niche.ad_style || 'soft',
    },
  }
}

module.exports = {
  NO_AD_SIGNALS,
  matchProduct,
  hasNoAdSignal,
  autoAdCap,
  capForNiche,
  decideAdStrategy,
  buildCommentParams,
}
