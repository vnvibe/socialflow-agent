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
  // 05/09: bài tuyển/tìm việc viết đủ kiểu — 'tìm job', 'ứng tuyển', 'hiring'.
  // Đo thật: bài 'TÌM JOB WEB / FREELANCE' lọt qua vì chỉ chặn 'tim viec'.
  'tim job', 'ung tuyen', 'hiring', 'recruit', 'tuyen ctv', 'can nguoi lam',
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

  // 3b. CHẾ ĐỘ AI-QUYẾT (user 22/08: "để AI tự quyết định bài nào có context đủ
  //     để quảng cáo"). aiEval từ evaluatePosts đọc TOÀN BỘ ngữ cảnh bài — không
  //     keyword matching. Khi AI đã chấm:
  //       pitch/recommend (ad_opportunity=true) → recommend (feed không pitch)
  //       seed → nhắc brand mềm 1 lần
  //       organic → tôn trọng, không ép
  //     Bỏ yêu cầu khớp keyword sản phẩm — đo thật 59/60 bài 0 hit nên đường
  //     keyword không bao giờ chạy; AI thay thế nó. Các gate an toàn phía trên
  //     (ad_enabled, trần/ngày, no_ad_signal) vẫn giữ nguyên.
  if (aiEval && (aiEval.ad_strategy || aiEval.ad_opportunity !== undefined)) {
    const strat = aiEval.ad_strategy === 'pitch' ? 'recommend' : aiEval.ad_strategy
    if (strat === 'recommend' || strat === 'seed') {
      const prods = niche.products || []
      const prod = prods.find(p => p?.name && p.name === aiEval.matched_product_name) || prods[0] || null
      const score = Number.isFinite(aiEval.ad_score) ? aiEval.ad_score : (Number.isFinite(aiEval.score) ? aiEval.score : 7)
      // NGƯỠNG ĐIỂM ÁP CẢ NHÁNH AI (fix 01/09): trước đây chỉ nhánh keyword so
      // ad_min_score, nhánh AI tin phán quyết vô điều kiện → seed score=5 vẫn
      // đăng dù cấu hình đòi ≥7 (đo thật: Tino bị nhét vào bài playwright-mcp,
      // bài MEMORY AI Agent chẳng liên quan hosting). AI thấy "có thể cài" ≠
      // bài ĐỦ HỢP để cài — ngưỡng của user là tiếng nói cuối.
      const minScore = Number.isFinite(niche.ad_min_score) ? niche.ad_min_score : 7
      // seed (nhắc brand MỀM 1 lần) được nới -1 điểm (03/09): gate cứng 7 cho
      // cả seed đã giết sạch quảng cáo feed (0 ad/24h, trước đó seed 5-6 điểm
      // là nguồn chính). recommend (nêu tên rõ) vẫn giữ đủ ngưỡng.
      let nguong = strat === 'seed' ? minScore - 1 : minScore
      // BÀI NGƯỜI TA ĐANG HỎI (06/09) — nick tự đi săn được (nguon='search',
      // đã qua coChoDeNoi) thì ngữ cảnh KHÔNG CẦN bàn nữa: dưới bài hỏi mua/
      // nhờ tư vấn, nói tên dịch vụ mình xài chính là trả lời câu hỏi. Ngưỡng
      // điểm sinh ra để chặn nhét brand vào bài vô can — chỗ này không phải
      // vậy. Hạ 2 điểm (sàn 3), chất lượng câu chữ đã có quality gate lo.
      if (usage.baiNhuCau) nguong = Math.max(3, nguong - 2)
      if (score < nguong) return organic(`ai_score_below_min:${score}<${nguong}`)
      return {
        strategy: strat,
        isAd: true,
        product: prod,
        score,
        reason: `ai_decided:${strat}${aiEval.ad_reason ? ':' + String(aiEval.ad_reason).slice(0, 80) : ''}`,
      }
    }
    return organic(`ai_decided:organic${aiEval.ad_reason ? ':' + String(aiEval.ad_reason).slice(0, 80) : ''}`)
  }

  // 4. (fallback không có AI) Phải khớp sản phẩm cụ thể — không khớp thì không có gì để nói
  const m = matchProduct(text, niche.products || [])
  if (!m) return organic('no_product_match')

  // Bài có người đang hỏi + khớp sản phẩm = cơ hội rõ ràng nhất, không cần
  // chờ AI chấm điểm (AI-eval chỉ chấm được 16 bài đầu mỗi phiên nên bài săn
  // thường rơi ra ngoài). Trả lời thẳng như người dùng thật.
  if (usage.baiNhuCau) {
    return {
      strategy: 'recommend',
      isAd: true,
      product: m.product,
      score: 8,
      reason: `bai_nhu_cau:${m.product.name}(${m.hits.join(',')})`,
    }
  }

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

/**
 * BÙ THIẾU QUẢNG CÁO THEO NHỊP NGÀY (user 01/09: "quảng cáo cần phải ưu tiên
 * 1 chút vì hiện tại rất ít").
 *
 * Đo thật 27-31/08: trần 20 quảng cáo/ngày nhưng chỉ đăng được ~5 — AI chấm
 * organic cho đa số bài và decideAdStrategy tôn trọng tuyệt đối, không có gì
 * kéo lại khi cả ngày hụt xa trần. Cơ chế: so số quảng cáo ĐÃ DÙNG với mức
 * "đáng lẽ phải có" theo tiến độ khung giờ hoạt động (07:00-22:00 VN). Đi sau
 * nhịp → cho phép NÂNG bài đủ điều kiện từ organic lên seed (nhắc brand mềm).
 *
 * KHÔNG phải ép quảng cáo bừa — bài được nâng vẫn phải qua đủ gate:
 *   - bài GẦN CAMP (tier niche / interest kề camp) — bài xa không bao giờ nâng
 *   - AI đã chấm bài đáng comment với điểm khá (score >= 6)
 *   - không dính NO_AD_SIGNALS (chia buồn, lừa đảo, tuyển dụng...)
 *   - chỉ nâng lên 'seed' (mềm nhất), không bao giờ recommend/pitch
 *   - quality gate + moderator phía sau vẫn chấm như mọi comment khác
 */
/**
 * Bài có CHỖ ĐỂ NÓI về dịch vụ không? (05/09)
 *
 * Chỉ hai loại bài đáng chèn thương hiệu một cách tự nhiên:
 *   1. NHU CẦU — người ta đang hỏi mua/thuê/tư vấn/so sánh/giá cả.
 *   2. VẤN ĐỀ hạ tầng — sập, chậm, lag, quá tải, lỗi cấu hình, hết tài nguyên.
 * Bài kể chuyện/giới thiệu công nghệ chung chung (gói tin đi qua DNS thế nào,
 * review một tool mã nguồn mở, tìm việc freelance) thì không có cửa — nhét vào
 * là quảng cáo dán, đúng thứ user phàn nàn "cứng quá".
 */
const DAU_HIEU_NHU_CAU = [
  'tu van', 'nen dung', 'nen chon', 'nen mua', 'so sanh', 'gia bao nhieu', 'bao gia',
  'thue', 'mua', 'can tim', 'dang tim', 'goi y', 'recommend', 'o dau tot', 'cho nao tot',
  'dung cai nao', 'loai nao', 'co ai dung', 'ai dung qua', 'review',
  // Câu hỏi tư vấn kiểu Việt: 'vps nào ổn định nhỉ', 'hosting nào tốt', 'cho hỏi'
  'nao on', 'nao tot', 'nao ngon', 'nao re', 'nao uy tin', 'cho hoi', 'ai biet',
]
const DAU_HIEU_VAN_DE = [
  'sap', 'downtime', 'cham', 'lag', 'qua tai', 'nghen', 'full cpu', 'full ram',
  'het ram', 'het dung luong', 'loi', 'crash', 'die', 'bi chan', 'timeout',
  'khong vao duoc', 'toi uu', 'nang cap', 'chuyen sang', 'doi nha cung cap',
]
function coChoDeNoi(text) {
  const norm = stripDiacritics(String(text || ''))
  return DAU_HIEU_NHU_CAU.some(k => norm.includes(stripDiacritics(k))) ||
         DAU_HIEU_VAN_DE.some(k => norm.includes(stripDiacritics(k)))
}

function adPaceDeficit(cap, used, now = new Date()) {
  if (!Number.isFinite(cap) || cap <= 0) return 0
  // Giờ VN từ epoch — không tin timezone của máy chạy.
  // 01/09: nhịp tính trên CẢ NGÀY (0-24h) — user chuyển newsfeed sang chạy
  // liên tục 24/24, feed-scheduler (VPS) đã bỏ khung ngủ đêm 8h-22h30.
  const vnHour = new Date(now.getTime() + 7 * 3600 * 1000).getUTCHours()
  const fraction = Math.max(0, Math.min(1, vnHour / 24))
  const expected = Math.floor(cap * fraction)
  return Math.max(0, expected - (used || 0))
}

/**
 * Thử nâng một quyết định organic lên seed để bù thiếu quảng cáo.
 * @returns quyết định mới (isAd=true, strategy='seed') hoặc null nếu không đủ điều kiện.
 */
function boostForDeficit(post, niche = {}, ctx = {}) {
  const { cap, used, adjacent, aiEval, now } = ctx
  if (!niche.ad_enabled) return null
  if (!adjacent) return null                                  // chỉ bài gần camp
  const deficit = adPaceDeficit(cap, used, now)
  if (deficit <= 0) return null                               // đang đúng/vượt nhịp
  if ((used || 0) >= cap) return null                         // không vượt trần ngày
  const score = aiEval && Number.isFinite(aiEval.score) ? aiEval.score : null
  if (score === null || score < 6) return null                // AI phải thấy bài khá
  const text = (post && post.text) || ''
  if (hasNoAdSignal(text)) return null                        // bài nhạy cảm
  // BÀI PHẢI CÓ CHỖ ĐỂ NÓI (siết 05/09, user "quảng cáo cứng quá"): trước đây
  // chỉ cần gần camp + điểm khá là nâng lên seed → brand bị nhét vào bài kể
  // chuyện gói tin DNS, bài tìm việc freelance... nghe rất giả. Nay đòi bài có
  // DẤU HIỆU NHU CẦU/VẤN ĐỀ hạ tầng thật thì mới cho nhắc thương hiệu.
  if (!coChoDeNoi(text)) return null
  const prods = niche.products || []
  return {
    strategy: 'seed',
    isAd: true,
    product: prods[0] || null,
    score,
    reason: `ad_deficit_boost:thieu_${deficit}_theo_nhip`,
  }
}

module.exports = {
  NO_AD_SIGNALS,
  matchProduct,
  hasNoAdSignal,
  autoAdCap,
  capForNiche,
  adPaceDeficit,
  coChoDeNoi,
  boostForDeficit,
  decideAdStrategy,
  buildCommentParams,
}
