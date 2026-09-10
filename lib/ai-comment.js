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
/**
 * Phát hiện META-OUTPUT của AI — model trả về phần suy luận/hướng dẫn thay vì
 * comment ("The user wants a comment as a...", "Here's a comment:", "Dưới đây
 * là bình luận..."). ĐÃ ĐĂNG THẬT 1 lần lên FB (23/06, luồng campaign) — lộ bot
 * nặng nhất có thể. Guard này dùng CHUNG cho mọi luồng sinh text (campaign,
 * feed, reply).
 */
const META_OUTPUT_PATTERNS = [
  /^(the user (wants|is|asked)|as an ai|as a language model|i (cannot|can't|am unable)|i'm sorry)/i,
  /^(sure|okay|ok|certainly|of course)?[,!.\s]*here('|')?s? (is )?(a |the |your )?(comment|reply|response|bình luận)/i,
  /^(dưới đây là|đây là) (bình luận|comment|câu trả lời|phản hồi)/i,
  /^(bình luận|comment|reply|response|câu trả lời)\s*[:：]/i,
  /^(gợi ý|suggested|draft)\s*(bình luận|comment)?\s*[:：]/i,
  /\b(system prompt|max_tokens|token limit|quality gate|as instructed|per your request)\b/i,
  /"thành viên thật"/i,   // trích dẫn ngoặc kép từ chính prompt — mẫu leak thật 23/06
]
function looksLikeMetaOutput(text) {
  const t = (text || '').trim()
  if (!t) return false
  return META_OUTPUT_PATTERNS.some(p => p.test(t))
}

/**
 * Comment ĐỨT GIỮA CÂU — model bị cắt token hoặc trả nửa chừng.
 *
 * Đo thật 01/09, ĐÃ ĐĂNG lên Facebook: "Mình thử, lớp học tương tác ngắn gọn,
 * ai cũng" — câu treo lơ lửng, lộ bot ngay. Quality gate không bắt (chấm ngữ
 * nghĩa, không soi đuôi câu) → guard tất định.
 *
 * Bắt 2 dạng đuôi: (1) kết thúc bằng dấu phẩy / gạch nối / hai chấm;
 * (2) kết thúc bằng TỪ NỐI hoặc từ chức năng tiếng Việt không bao giờ đứng
 * cuối câu hoàn chỉnh (và, nhưng, mà, thì, của, để, khi, nếu, cũng, đã, sẽ,
 * đang, rất, hơi, với, cho, về, từ, các, những, một...). Danh sách high-
 * precision: "rồi/nhé/đó/thôi/luôn/nữa/không/chưa/à/ạ/hả/nhỉ" là đuôi câu hợp
 * lệ của văn nói nên KHÔNG nằm trong này.
 */
const DANGLING_TAIL_WORDS = new Set([
  'và', 'nhưng', 'mà', 'thì', 'là', 'của', 'để', 'khi', 'nếu', 'vì',
  'cũng', 'đã', 'sẽ', 'đang', 'rất', 'hơi', 'với', 'cho', 'về', 'từ',
  'các', 'những', 'một', 'bị', 'được', 'nên', 'hoặc', 'còn', 'tại', 'trong',
])
function looksTruncated(text) {
  const t = (text || '').trim()
  if (!t) return false
  if (/[,:;\-–—]$/.test(t)) return true
  const cuoi = t.split(/\s+/).pop().replace(/[.!?…]+$/, '').toLowerCase()
  return DANGLING_TAIL_WORDS.has(cuoi)
}

/**
 * Comment NHẮC TÊN CHÍNH NICK ở ngôi thứ ba — dấu hiệu lộ bot nặng nhất.
 *
 * Đo thật 25/08: nick Lorena đăng "Bấm link rồi vào server an ninh, Lorena cũng
 * đã join rồi" — người thật không bao giờ tự gọi tên mình như vậy. Quality gate
 * AI chấm comment này fluency=9 naturalness=9, tức AI KHÔNG bắt được lỗi này →
 * phải có guard tất định, không phụ thuộc model.
 *
 * Chỉ xét tên đủ dài (>=4 ký tự) và so theo ranh giới từ để không dính tên quá
 * phổ thông lọt vào giữa từ khác.
 */
function mentionsOwnNick(comment, username) {
  const c = String(comment || '')
  const u = String(username || '').trim()
  if (!c || !u) return null
  // Xét cả họ tên đầy đủ lẫn từng phần tên (>=4 ký tự) — "Lorena Cezara" thì
  // "Lorena" một mình cũng đã đủ lộ.
  const parts = [u, ...u.split(/\s+/)].filter(x => x && x.length >= 4)
  for (const part of parts) {
    const esc = part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    // Ranh giới "không phải chữ cái" ở hai đầu — tránh dính tên nằm trong từ khác.
    const re = new RegExp('(^|[^\\p{L}])' + esc + '([^\\p{L}]|$)', 'iu')
    if (re.test(c)) return part
  }
  return null
}

/**
 * Số liệu BỊA — comment nêu phần trăm hoặc "gấp N lần" mà bài gốc không hề có.
 *
 * Đo thật: "review 30% giảm ngay", "latency giảm 30% khi dùng Qdrant" trên bài
 * không nhắc con số nào. Prompt đã cấm bịa số (rule 4) nhưng model vẫn vi phạm,
 * nên chặn tại đây. CHỈ bắt % và "gấp N lần" — số kỹ thuật thường (8GB, 4 nhân,
 * cổng 443) là kinh nghiệm hợp lệ của người dùng, không tính.
 */
function fabricatesStat(comment, postText) {
  const c = String(comment || '')
  const p = String(postText || '')
  const stats = []
  for (const m of c.matchAll(/(\d+(?:[.,]\d+)?)\s*%/g)) stats.push({ n: m[1], kind: '%' })
  for (const m of c.matchAll(/gấp\s*(\d+(?:[.,]\d+)?)\s*lần/gi)) stats.push({ n: m[1], kind: ' lần' })
  // "tăng lượt xem 2-3 lần trong tuần đầu" (đăng thật 02/09) — bịa hệ số không
  // có chữ "gấp" nên guard cũ trượt. CHỈ bắt dạng KHOẢNG "2-3 lần" (tín hiệu
  // bịa số liệu đặc trưng); "N lần" đơn để yên — "thử 1 lần", "đọc 2 lần" là
  // văn nói bình thường, bắt là oan hàng loạt.
  for (const m of c.matchAll(/(\d+(?:[.,]\d+)?)\s*[-–]\s*(\d+(?:[.,]\d+)?)\s*lần/gi)) {
    stats.push({ n: m[1], kind: ' lần' })
    stats.push({ n: m[2], kind: ' lần' })
  }
  if (!stats.length) return null
  for (const s of stats) {
    if (!p.includes(s.n)) return s.n + s.kind
  }
  return null
}

/**
 * SAI TÊN THƯƠNG HIỆU — model tự chế biến thể của brand (05/09).
 *
 * Đo thật, ĐÃ ĐĂNG lên Facebook: "Mình dùng TinoX đã, trơn trượt, 0 lag" và
 * "mình tin TinoHost cho VPS". Thương hiệu là "Tino" — TinoX/TinoHost là hai
 * công ty KHÔNG tồn tại (TinoHost còn là tên đối thủ có thật ngoài đời). Quảng
 * cáo sai tên vừa vô nghĩa vừa quảng cáo hộ người khác.
 *
 * Bắt: token bắt đầu bằng tên brand nhưng DÍNH thêm chữ/số phía sau
 * (TinoX, TinoHost, Tinovn), hoặc brand + một từ Viết Hoa liền kề tạo thành
 * tên sản phẩm không có trong danh sách sản phẩm thật (Tino Cloud, Tino Pro).
 * CHO QUA: đúng "Tino", và "Tino" + từ thường ("Tino thấy ổn"), và tên sản
 * phẩm có thật trong products.
 */
function saiTenThuongHieu(comment, brandName, productNames = []) {
  const c = String(comment || '')
  const b = String(brandName || '').trim()
  if (!c || !b) return null
  const okNames = new Set([b.toLowerCase(), ...productNames.map(p => String(p || '').toLowerCase().trim()).filter(Boolean)])

  // 1. Dính hậu tố: Tino + chữ/số liền (TinoX, TinoHost, Tino2)
  const dinh = new RegExp(`\\b${b.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}[\\p{L}\\p{N}]+`, 'giu')
  const m1 = c.match(dinh)
  if (m1) {
    for (const t of m1) if (!okNames.has(t.toLowerCase())) return t
  }
  // 2. Brand + từ Viết Hoa liền kề (Tino Cloud, Tino Pro) không có trong products
  const ghep = new RegExp(`\\b${b.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\s+(\\p{Lu}[\\p{L}\\p{N}]+)`, 'gu')
  let m2
  while ((m2 = ghep.exec(c)) !== null) {
    const full = `${b} ${m2[1]}`
    if (!okNames.has(full.toLowerCase())) return full
  }
  return null
}

/**
 * KHUÔN QUẢNG CÁO SÁO RỖNG (05/09) — model nhét cùng một mẫu câu vào mọi bài.
 *
 * Đo thật 5 ngày: "Mình đang xài Tino, thấy ổn áp" / "Mình đi thử Tino, vẫn ổn
 * áp" / "Đã xài Tino thử, chạy mượt" / "Tino giúp triển khai nhanh mà ổn áp" —
 * dán được vào BẤT KỲ bài nào, kể cả bài về gói tin DNS hay bài tìm việc
 * freelance. Nguồn gốc: prompt seed từng nêu ví dụ "mình đang xài X thấy ổn"
 * nên model chép nguyên khuôn.
 *
 * Bắt khi comment vừa nhắc brand VỪA rơi vào mẫu "dùng/xài/thử BRAND + lời
 * khen chung chung" mà không kèm chi tiết kỹ thuật nào (số, đơn vị, tên công
 * nghệ). Người thật khen thì khen CÁI GÌ cụ thể.
 */
const KHEN_CHUNG = /(ổn áp|ổn lắm|ổn phết|mượt|ngon|xịn|chất|ok lắm|tốt lắm|0 lag|không lag|chưa thấy lag|trơn tru|trơn trượt)/i
/**
 * QUẢNG CÁO TỰ BÔI XẤU (07/09) — lỗi ngu nhất có thể mắc.
 *
 * Ca thật đã ĐĂNG: bài "Góc cần tìm vps ổn. 1 tháng ở đây down 4, 5 lần, anh
 * em tư vấn cho mình chỗ nào ổn mà giá same same" → comment "Ngay khi mình thử
 * 1 CPU/2GB Tino, down chỉ 1 lần 2 tuần." Tức là đi tư vấn cho người đang chán
 * vì hay sập, bằng cách khoe dịch vụ mình... cũng sập (1 lần/2 tuần = 2
 * lần/tháng). Vừa không thuyết phục vừa dựng sẵn bằng chứng xấu về thương hiệu.
 *
 * Luật: trong CÂU có nhắc thương hiệu, không được xuất hiện từ sự cố (down,
 * sập, lag, lỗi, chậm, treo, đơ, mất...) — TRỪ KHI câu đó nói rõ là ĐÃ HẾT
 * (hết/không còn/không bị/chưa bị/chưa gặp/khỏi/hết hẳn), vì "chuyển qua X thì
 * hết sập" là câu quảng cáo hợp lệ và mạnh.
 */
const TU_SU_CO = /(down|sập|sap\b|lag|lỗi|loi\b|chậm|cham\b|treo|đơ|do\b|mất kết nối|mat ket noi|timeout|quá tải|qua tai|reboot|restart|die\b|crash|gián đoạn|gian doan)/i
const TU_DA_HET = /(hết|het\b|không còn|khong con|không bị|khong bi|chưa bị|chua bi|chưa gặp|chua gap|chưa thấy|chua thay|khỏi|khoi\b|không hề|khong he|chưa lần nào|chua lan nao|không dính|khong dinh)/i
function quangCaoTuBoiXau(comment, brandName) {
  const c = String(comment || '')
  const b = String(brandName || '').trim()
  if (!c || !b) return null
  const reBrand = new RegExp(`\\b${b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i')
  // Tách câu theo dấu chấm/chấm than/hỏi/xuống dòng
  for (const cau of c.split(/[.!?\n]+/)) {
    if (!reBrand.test(cau)) continue
    const suCo = cau.match(TU_SU_CO)
    if (suCo && !TU_DA_HET.test(cau)) {
      return suCo[0]
    }
  }
  return null
}

function khuonQuangCaoSao(comment, brandName) {
  const c = String(comment || '')
  const b = String(brandName || '').trim()
  if (!c || !b || !new RegExp(`\\b${b}`, 'i').test(c)) return null
  const dungBrand = new RegExp(`(dùng|xài|thử|deploy|triển khai|chạy trên|tin)\\s+[^.,;]{0,25}${b}`, 'i')
  if (!dungBrand.test(c)) return null
  if (!KHEN_CHUNG.test(c)) return null
  // Có chi tiết kỹ thuật cụ thể (số + đơn vị, hoặc tên công nghệ trong bài) → tha
  const coChiTiet = /\d+\s*(gb|mb|tb|cpu|core|nhân|ms|s\b|k\/tháng|đ|vnd|%)|\b(nginx|docker|ssl|dns|api|backup|cronjob|redis|mysql|postgres|wordpress|cloudflare|firewall|ram)\b/i
  if (coChiTiet.test(c)) return null
  return c.match(dungBrand)[0].trim()
}

// Bịa TÊN MIỀN / TÊN SẢN PHẨM có đuôi web mà bài gốc không hề nhắc.
//
// Lỗi đo được thật 26/08: dưới bài về AI dựng video, nick comment "Mình cũng
// thử mv1fD9.com, gỡ template math nhanh..." — tên miền hoàn toàn bịa. Cổng
// chất lượng AI chấm lọt vì câu vẫn trôi chảy; guard số liệu không bắt vì
// không có con số nào. Người thật không giới thiệu một tên miền không tồn tại.
//
// Cho qua tên miền ĐÃ có trong bài gốc (đang bàn về nó thì nhắc lại là bình
// thường) và tên miền của chính thương hiệu mình (quảng cáo hợp lệ — feed-seed
// truyền brandDomains xuống từ niche.products).
const DOMAIN_RE = /\b((?:[a-z0-9][a-z0-9-]*\.)+(?:com|net|org|vn|io|dev|ai|co|xyz|me|app|site|online|shop|info|biz|cloud|tech))\b/gi
function fabricatesDomain(comment, postText, brandDomains = []) {
  const cho = new Set([
    ...String(postText || '').toLowerCase().match(DOMAIN_RE) || [],
    ...brandDomains.map(d => String(d || '').toLowerCase().trim()).filter(Boolean),
  ])
  for (const d of String(comment || '').match(DOMAIN_RE) || []) {
    if (!cho.has(d.toLowerCase())) return d
  }
  return null
}

// GIỌNG MÁY MÓC — bắt tất định hai lỗi mà cổng chất lượng AI chấm SÓT.
//
// Đo thật 27/08: comment "Tôi đã chuyển sang Tino, hỗ trợ nhanh, không gặp lỗi
// như mtdvps, hờ vậy ổn áp." được gate chấm fluency 8-9 và CHO QUA ở cả hai
// lần siết prompt. Prompt đã cấm rõ xưng "tôi" và cấm nối phẩy, nhưng model
// vẫn bỏ lọt — nên chốt bằng luật, không phụ thuộc model nữa.
//
//  1. Xưng "tôi"/"chúng ta": người Việt tán gẫu trên FB xưng mình/em/bác/bạn.
//     "Chúng ta phải kiểm tra độ tin cậy" nghe như đọc báo cáo.
//  2. Câu nối phẩy lê thê: nhiều dấu phẩy mà không một dấu chấm ngắt ý — dấu
//     vết máy rõ nhất, và là thứ user chê "thiếu mượt mà".
function giongMayMoc(comment) {
  const t = String(comment || '').trim()
  if (!t) return null
  if (/(^|[\s,.!?"'(])tôi([\s,.!?"')]|$)/i.test(t)) return 'xung_toi'
  if (/(^|[\s,.!?"'(])chúng ta([\s,.!?"')]|$)/i.test(t)) return 'xung_chung_ta'
  // Loạn ngôi xưng: hỏi tác giả bài viết nhưng gọi họ là "mình" ("mình thấy sao?", "mình thấy thế nào?") — lỗi hoang tưởng bot 10/09
  if (/(^|[\s,])mình thấy (sao|thế nào)\s*[?？]/i.test(t)) return 'loan_ngoi_minh_thay_sao'
  // Từ vô nghĩa / hallucination kỳ dị (như 'gehihi')
  if (/\bgehihi\b/i.test(t)) return 'tu_vo_nghia_gehihi'
  // Ngắt câu giữa chừng: dấu kết thúc câu KHÔNG nằm ở cuối chuỗi
  const coNgatCau = /[.!?…]\s+\S/.test(t)
  const soPhay = (t.match(/,/g) || []).length
  if (!coNgatCau && soPhay >= 2 && t.length > 70) return `noi_phay:${soPhay}`
  return null
}

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

    // NHẠI THẬT = CHÉP CỤM LIÊN TIẾP, không phải "trùng từ đơn" (sửa 06/09).
    //
    // Ngưỡng Jaccard-từ-đơn 45% cũ loại 62/262 lượt sinh trong 7 ngày — nhiều
    // nhất trong mọi lý do, và loại OAN hàng loạt. Lý do: prompt BẮT comment
    // bám chi tiết cụ thể của bài, nên bàn về bài Jira/Confluence thì đương
    // nhiên trùng thuật ngữ. Hai luật của chính hệ thống đánh nhau.
    //   Ví dụ bị loại oan (50%): "Jira cấu hình Epic, Feature, User Story thật
    //   hay. Confluence lưu doc đẹp nhưng versioning khó khi gộp page."
    //   Ví dụ nhại thật (57%): "Agent được phép đọc web, nhưng chiếm wiki 10
    //   năm là quá" ← chép nguyên cụm mở đầu của bài.
    // Phân biệt được bằng CỤM 3 TỪ LIÊN TIẾP: người viết thật dùng lại thuật
    // ngữ rời rạc; máy nhại thì bê nguyên cụm. Giữ Jaccard làm lưới cuối nhưng
    // đẩy lên 0.75 (gần như chép cả câu).
    const trigrams = (words) => {
      const s = new Set()
      for (let i = 0; i + 2 < words.length; i++) s.add(words[i] + ' ' + words[i + 1] + ' ' + words[i + 2])
      return s
    }
    const cTri = trigrams(commentWords)
    if (cTri.size >= 2) {
      const pTri = trigrams(postWords)
      let trung = 0
      for (const t of cTri) if (pTri.has(t)) trung++
      const tyLe = trung / cTri.size
      if (tyLe > 0.25) {
        return { valid: false, reason: `echo_cum_lien_tiep:${(tyLe * 100).toFixed(0)}%` }
      }
    }

    // BÊ NGUYÊN MỘT CỤM DÀI: chép đúng 5 từ liên tiếp của bài là chép, dù phần
    // còn lại tự viết nên tỉ lệ trigram vẫn thấp. Ca thật: bài mở đầu "Agent
    // được phép đọc web..." → comment "Agent được phép đọc web, nhưng chiếm
    // wiki 10 năm là quá" (nửa đầu bê nguyên). Check substring cũ chỉ soi 30 ký
    // tự ĐẦU bài nên trượt. Người viết thật gần như không bao giờ lặp đúng 5 từ
    // liền của bài.
    if (commentWords.length >= 5 && postWords.length >= 5) {
      const pNgram = new Set()
      for (let i = 0; i + 4 < postWords.length; i++) pNgram.add(postWords.slice(i, i + 5).join(' '))
      for (let i = 0; i + 4 < commentWords.length; i++) {
        const cum = commentWords.slice(i, i + 5).join(' ')
        if (pNgram.has(cum)) {
          return { valid: false, reason: `echo_be_nguyen_cum:${cum.slice(0, 40)}` }
        }
      }
    }
    if (similarity > 0.75) {
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
        } else if (looksLikeMetaOutput(comment)) {
          // Model trả suy luận/meta thay vì comment — TUYỆT ĐỐI không đăng (leak thật 23/06)
          console.warn(`[AI-COMMENT] REJECTED meta-output: "${comment.substring(0, 60)}"`)
          hermes.sendFeedback({
            taskType: 'comment_gen', outputText: comment, score: 1,
            accountId, reason: 'meta_output_rejected',
          })
          return { text: '', ai: false, reason: 'meta_output_rejected' }
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
      if (!comment || comment.length < 10 || comment === '...' || /^\.+$/.test(comment) || looksLikeMetaOutput(comment)) {
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
      if (!comment || comment.length < 10 || comment === '...' || /^\.+$/.test(comment) || looksLikeMetaOutput(comment)) {
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

module.exports = { generateComment, generateOpportunityComment, classifyIntent, validateCommentNotEcho, looksLikeMetaOutput, looksTruncated, mentionsOwnNick, fabricatesStat, fabricatesDomain, giongMayMoc, saiTenThuongHieu, khuonQuangCaoSao, quangCaoTuBoiXau }
