/**
 * feed-filter.js — Phễu lọc bài newsfeed (Tầng 0 + Tầng 1, pure functions).
 *
 * Tầng 0 (loại trừ cứng, miễn phí): nick nhà, đối thủ, blocklist, bài đã comment,
 *        bài của Page, bài quảng cáo, chủ đề nhạy cảm.
 * Tầng 1 (lọc thô từ khoá, miễn phí): khớp target_keywords + loại negative_keywords.
 * Tầng 2-4 (AI chấm điểm / sinh / gate) nằm ở handler — file này chỉ lo phần local.
 *
 * NGUYÊN TẮC FAIL-CLOSED: nếu không chắc → loại bài, không comment.
 */

// Bỏ dấu tiếng Việt để so khớp không phân biệt dấu.
function stripDiacritics(s) {
  return (s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd').replace(/Đ/g, 'D')
    .toLowerCase()
}

// So khớp theo RANH GIỚI TỪ, không phải chuỗi con.
//
// Dùng includes() thì mẫu ngắn phá hoại: 'rip' khớp trong script, description,
// subscription, stripe, trip — tức là bài ĐÚNG NGÀNH nhất (VPS/hosting/dev)
// bị chặn với lý do 'sensitive_topic:rip'. Đã kiểm: 3/4 bài VPS thật bị loại oan.
// Mẫu NHIỀU TỪ ('chia buồn') vẫn dùng includes vì bản thân nó đã đủ đặc trưng;
// chỉ mẫu MỘT TỪ mới cần ranh giới.
function matchesWholeWord(normText, kw) {
  if (!kw) return false
  if (kw.includes(' ')) return normText.includes(kw)   // cụm từ: an toàn với includes
  // \b không dùng được vì normText đã bỏ dấu nhưng vẫn có thể chứa ký tự lạ;
  // tự kiểm ký tự liền trước/sau không phải chữ-số.
  let from = 0
  for (;;) {
    const i = normText.indexOf(kw, from)
    if (i === -1) return false
    const before = i === 0 ? '' : normText[i - 1]
    const after = normText[i + kw.length] || ''
    const isWordChar = (ch) => ch !== '' && /[a-z0-9]/.test(ch)
    if (!isWordChar(before) && !isWordChar(after)) return true
    from = i + 1
  }
}

// Chủ đề nhạy cảm — comment quảng cáo vào là phản cảm, dễ bị report.
const SENSITIVE_PATTERNS = [
  // Tang lễ / mất mát
  'chia buồn', 'phân ưu', 'tang lễ', 'đám tang', 'rip', 'an nghỉ', 'mất rồi',
  'tai nạn', 'tử vong', 'qua đời', 'cầu nguyện', 'cầu siêu', 'an táng',
  'hy sinh', 'liệt sĩ', 'mộ phần', 'thi thể', 'nạn nhân',
  // Tội phạm / bạo lực — người viết hay VIẾT LIỀN để né bộ lọc của Facebook,
  // nên phải bắt cả biến thể không dấu cách (quan sát thấy 'baohanh' trên feed thật)
  'bạo hành', 'baohanh', 'hành hạ', 'đánh đập', 'giết', 'sát hại', 'án mạng',
  'hiếp dâm', 'xâm hại', 'bắt cóc', 'lừa đảo', 'tạm giữ', 'khởi tố', 'bắt giam',
  'công an', 'lấy lời khai', 'truy nã',
  // Sức khoẻ / chính trị / tôn giáo
  'chính trị', 'biểu tình', 'tôn giáo', 'ung thư', 'bệnh hiểm nghèo',
  'cấp cứu', 'hôn mê', 'ngộ độc', 'dịch bệnh',
  // Kêu gọi từ thiện — comment vào dễ bị hiểu là lợi dụng
  'kêu gọi ủng hộ', 'quyên góp', 'hoàn cảnh khó khăn',
].map(stripDiacritics)

// ── TÍN HIỆU SỞ THÍCH (AFFINITY) — dùng để HUẤN LUYỆN THUẬT TOÁN FB ──
//
// Khác target_keywords (hẹp, để COMMENT đúng VPS/Hosting), danh sách này RỘNG
// theo cả mảng "tech" — vps, hosting, cloud, dev, AI... Mục đích: nick like +
// dừng-đọc bài tech để Facebook học "nick này mê công nghệ" và ĐẨY THÊM bài đúng
// ngách vào feed. Đây là quá trình NHIỀU NGÀY (không phải ngày 1-2 là giàu ngay):
// feed cá nhân nghèo bài VPS → phải nuôi tín hiệu tech trước, feed giàu dần thì
// comment đúng ngách mới có bài để chạy.
//
// DÙNG matchesWholeWord (không phải includes): 'ai'/'it' dạng chuỗi con dính vô
// số từ tiếng Việt/Anh (email, mail, main...) → phải khớp theo ranh giới từ. Vẫn
// bỏ hẳn 'ai'/'it' trần vì kể cả whole-word chúng vẫn quá nhiễu; thay bằng tên
// cụ thể (chatgpt, openai, gpt...). Khớp nhầm ở đây chỉ tốn 1 LIKE (rẻ, còn tăng
// vẻ tự nhiên), không đụng tới comment — nên ngưỡng để lọt thoáng hơn Tầng 1.
const TECH_AFFINITY = [
  // Hạ tầng / hosting (rộng hơn target_keywords)
  'vps', 'hosting', 'host', 'server', 'may chu', 'cloud', 'dam may', 'domain',
  'ten mien', 'website', 'web', 'wordpress', 'ssl', 'bang thong', 'datacenter',
  'data center', 'vpn', 'cpanel', 'nginx', 'apache', 'cdn', 'cloudflare', 'aws',
  'azure', 'google cloud', 'digitalocean', 'hostinger', 'namecheap',
  // VPS / server-admin MỞ RỘNG — để nhận diện + like nhiều bài VPS hơn, dạy
  // thuật toán FB đẩy thêm nội dung VPS vào feed (user 22/08). High-precision:
  // dùng cụm/thuật ngữ đặc trưng, TRÁNH từ ngắn mơ hồ ('ram' trùng chả ram,
  // 'ping' trùng nhắn tin) — matchesWholeWord lo ranh giới từ.
  'may chu ao', 'may chu rieng', 'dedicated server', 'thue vps', 'thue server',
  'vps gia re', 'hosting gia re', 'shared hosting', 'cloud hosting', 'colocation',
  'ssh', 'rdp', 'kvm', 'openvz', 'proxmox', 'vmware', 'plesk', 'directadmin',
  'aapanel', 'cyberpanel', 'centos', 'debian', 'almalinux', 'ubuntu server',
  'ddos', 'firewall', 'load balancer', 'reverse proxy', 'nvme', 'ssd', 'cpu',
  'uptime', 'downtime', 'vultr', 'linode', 'contabo', 'ovh', 'droplet', 'ec2',
  'chung chi ssl', 'dang ky ten mien', 'control panel', 'nat vps', 'sysadmin',
  'cau hinh server', 'quan tri server', 'thue may chu',
  // Dev / lập trình
  'lap trinh', 'code', 'coder', 'developer', 'dev', 'devops', 'phan mem',
  'software', 'api', 'github', 'docker', 'kubernetes', 'linux', 'ubuntu',
  'python', 'javascript', 'nodejs', 'react', 'database', 'backend', 'frontend',
  // AI / công cụ
  'tri tue nhan tao', 'chatgpt', 'openai', 'claude', 'gpt', 'gemini',
  'machine learning', 'automation', 'tu dong hoa', 'saas', 'no-code', 'nocode',
  // Tool/brand người dùng chỉ định ưu tiên tương tác.
  // Chỉ 'hermes agent' (cụm) — KHÔNG dùng 'hermes' trần vì trùng hãng túi Hermès.
  'openclaw', 'hermes agent', 'ai agent', 'coding agent',
  // Tech chung / bảo mật
  'cong nghe', 'tech', 'cong nghe thong tin', 'bao mat', 'security', 'cyber',
].map(stripDiacritics)

// HIGH_AFFINITY = tập con GẦN HƯỚNG CAMP (VPS/Hosting/server/hạ tầng/devops/
// bảo mật — thứ người dùng/mua VPS quan tâm). Dùng để feed-seed ƯU TIÊN chọn &
// comment bài gần camp, bớt sa đà vào AI-chat/content thuần (user 22/08: "vẫn
// cmt bài tech được nhưng cần tìm và lựa nhiều hơn" — lệch camp). Các từ AI
// thuần (chatgpt/gemini/claude/gpt/ML), coding-language thuần (python/js/react/
// code), content, tech chung → KHÔNG nằm đây = xa camp, chỉ comment khi thiếu
// bài gần.
const HIGH_AFFINITY = new Set([
  // Hosting / hạ tầng
  'vps', 'hosting', 'host', 'server', 'may chu', 'cloud', 'dam may', 'domain',
  'ten mien', 'website', 'web', 'wordpress', 'ssl', 'bang thong', 'datacenter',
  'data center', 'vpn', 'cpanel', 'nginx', 'apache', 'cdn', 'cloudflare', 'aws',
  'azure', 'google cloud', 'digitalocean', 'hostinger', 'namecheap',
  // VPS / server-admin mở rộng
  'may chu ao', 'may chu rieng', 'dedicated server', 'thue vps', 'thue server',
  'vps gia re', 'hosting gia re', 'shared hosting', 'cloud hosting', 'colocation',
  'ssh', 'rdp', 'kvm', 'openvz', 'proxmox', 'vmware', 'plesk', 'directadmin',
  'aapanel', 'cyberpanel', 'centos', 'debian', 'almalinux', 'ubuntu server',
  'ddos', 'firewall', 'load balancer', 'reverse proxy', 'nvme', 'ssd', 'cpu',
  'uptime', 'downtime', 'vultr', 'linode', 'contabo', 'ovh', 'droplet', 'ec2',
  'chung chi ssl', 'dang ky ten mien', 'control panel', 'nat vps', 'sysadmin',
  'cau hinh server', 'quan tri server', 'thue may chu',
  // Devops/server-side (kề VPS admin)
  'devops', 'docker', 'kubernetes', 'linux', 'ubuntu', 'database', 'backend',
  'github', 'api', 'nodejs', 'bao mat', 'security', 'cyber',
  // Tool brand hệ sinh thái do user chỉ định
  'openclaw', 'hermes agent',
].map(stripDiacritics))

function isHighAffinity(kw) {
  return kw != null && HIGH_AFFINITY.has(stripDiacritics(kw))
}

function matchesAffinity(normText) {
  // Ưu tiên trả về từ khoá GẦN CAMP nếu bài khớp cả 2 nhóm (để tier/adjacency
  // phản ánh đúng mức liên quan camp).
  let low = null
  for (const kw of TECH_AFFINITY) {
    if (matchesWholeWord(normText, kw)) {
      if (HIGH_AFFINITY.has(kw)) return kw
      if (!low) low = kw
    }
  }
  return low
}

// Nhận diện bài TIẾNG VIỆT — chỉ comment bài tiếng Việt (nick VN comment tiếng
// Việt vào bài tiếng Trung/Anh/Nhật = lệch ngôn ngữ, lộ bot). Không đụng tới
// LIKE (feed_scroll vẫn like bài tech mọi ngôn ngữ để dạy thuật toán).
//
// Từ thông dụng dạng KHÔNG DẤU (người Việt hay gõ không dấu) — dùng để bắt bài
// tiếng Việt không dấu; so theo ranh giới từ (đệm khoảng trắng 2 đầu).
const VI_COMMON_WORDS = [
  'va', 'cua', 'la', 'khong', 'co', 'cho', 'minh', 'ban', 'voi', 'nguoi',
  'duoc', 'nhe', 'oi', 'nay', 'the', 'can', 'mua', 'ban', 'nhung', 'khi',
  'thi', 'ma', 'rat', 'lam', 'hay', 'nhu', 'moi', 'cac', 'nen', 'roi',
]
// Nhãn giao diện Facebook (bản tiếng Việt) BỊ DÍNH vào text khi scrape —
// "Xem thêm"/"Xem bản dịch" luôn là tiếng Việt (có dấu ê/ị) nên làm MỌI bài,
// kể cả bài tiếng Anh/Trung, trông như tiếng Việt → vô hiệu hoá lọc ngôn ngữ.
// BUG THẬT (audit 19/08): bài "Claude is working for me..." lọt vì đuôi "… Xem
// thêm". Phải cắt các nhãn này TRƯỚC khi xét ngôn ngữ nội dung thật.
const FB_UI_NOISE = /(xem thêm|xem bản dịch|xem thêm về|thu gọn|đã dịch|see more|see translation|see original|show more)/gi
function stripFbUiNoise(s) {
  return (s || '').replace(FB_UI_NOISE, ' ').replace(/[……]+/g, ' ').trim()
}

function isVietnamese(text) {
  const t = stripFbUiNoise(text)
  if (!t.trim()) return false
  // Có ký tự Trung/Nhật/Hàn → KHÔNG phải tiếng Việt → loại ngay.
  if (/[一-鿿぀-ヿ가-힯]/.test(t)) return false
  // BUG 25/08 (user chỉ ra bằng ảnh): danh sách cũ gồm cả dấu DÙNG CHUNG với
  // Bồ Đào Nha / Pháp / Tây Ban Nha / Ý (à á ã è é ì í ò ó õ ù ú â ê ô). Bài
  // tiếng Bồ "O DeepSeek Harness é um sistema... codificação... lançado" khớp
  // ngay ở 'é'/'ã' → bị coi là tiếng Việt → nick comment tiếng Việt vào bài
  // ngoại ngữ. Camp yêu cầu CHỈ tiếng Việt nên đây là lỗi nặng.
  //
  // Nay chỉ nhận ký tự RIÊNG tiếng Việt — chữ có móc (ơ ư), á breve (ă), đ gạch,
  // dấu hỏi/nặng dưới nguyên âm (ả ạ ẻ ẹ ỉ ị ỏ ọ ủ ụ ỷ ỵ), và nguyên âm đội mũ
  // KÈM thanh (ầ ấ ẩ ẫ ậ / ề ế ể ễ ệ / ồ ố ổ ỗ ộ). Các chữ này không tồn tại
  // trong những ngôn ngữ Latin kể trên.
  if (/[ăằắẳẵặầấẩẫậđảạẻẽẹềếểễệỉĩịỏọồốổỗộơờớởỡợủũụưừứửữựỳỷỹỵ]/i.test(t)) return true

  // Đếm từ tiếng Việt thông dụng (dạng không dấu) — dùng cho CẢ bài không dấu
  // LẪN bài chỉ dùng dấu trùng với ngôn ngữ Latin khác.
  const padded = ' ' + stripDiacritics(t) + ' '
  let hits = 0
  for (const w of VI_COMMON_WORDS) {
    if (padded.includes(' ' + w + ' ')) hits++
  }

  // Có dấu Latin của ngôn ngữ KHÁC mà không có ký tự Việt riêng ở trên → NGHI
  // ngoại ngữ, đòi bằng chứng mạnh hơn (≥3 từ Việt). KHÔNG chặn thẳng: bài tiếng
  // Việt hoàn toàn có thể chỉ dùng dấu chung — ví dụ thật suýt bị loại oan:
  // "Trade-off trong System Design là gì? Vì sao không có Architecture hoàn hảo"
  // (chỉ có ì/ô, không có ơ/ư/đ).
  if (/[çñüßœæåøłšžčğıàáâãèéêìíîòóôõùúûýÿ]/i.test(t)) return hits >= 3

  // Không dấu: cần ≥2 từ tiếng Việt thông dụng (tránh bắt nhầm bài tiếng Anh
  // có 'co'/'la' lẻ tẻ).
  return hits >= 2
}

/**
 * Dựng context loại trừ 1 lần đầu phiên (để tra nhanh trong vòng lặp).
 * @param {object} p
 *   ownNickFbIds:     string[]  — TẤT CẢ fb_user_id nick trong hệ thống (chặn comment chéo)
 *   commentedPostIds: string[]  — post đã comment (từ feed_actions)
 *   exclusions:       [{exclude_type, value, is_active}]  — bảng feed_exclusions
 */
function buildExclusionContext({ ownNickFbIds = [], commentedPostIds = [], exclusions = [] } = {}) {
  const ctx = {
    ownNicks: new Set(ownNickFbIds.filter(Boolean).map(String)),
    commented: new Set(commentedPostIds.filter(Boolean).map(String)),
    competitorIds: new Set(),
    competitorKeywords: [],
    blockedUsers: new Set(),
    blockedTopics: [],
  }
  for (const ex of exclusions) {
    if (ex.is_active === false || !ex.value) continue
    const v = String(ex.value)
    switch (ex.exclude_type) {
      case 'competitor_page':    ctx.competitorIds.add(v); break
      case 'blocked_user':       ctx.blockedUsers.add(v); break
      case 'competitor_keyword': ctx.competitorKeywords.push(stripDiacritics(v)); break
      case 'blocked_topic':      ctx.blockedTopics.push(stripDiacritics(v)); break
    }
  }
  return ctx
}

/**
 * TẦNG 0 — loại trừ cứng. Trả { ok: true } hoặc { ok: false, reason }.
 * post shape kỳ vọng: { fbPostId, authorFbId, authorType('user'|'page'), text, isAd }
 * Fail-closed: thiếu dữ liệu định danh → loại.
 */
function passesHardExclusion(post, ctx) {
  if (!post) return { ok: false, reason: 'no_post' }
  const authorId = post.authorFbId ? String(post.authorFbId) : null
  const postId = post.fbPostId ? String(post.fbPostId) : null

  // Bài quảng cáo/sponsored
  if (post.isAd) return { ok: false, reason: 'ad_post' }

  // Bài của Page (yêu cầu: chỉ nick cá nhân)
  if (post.authorType === 'page') return { ok: false, reason: 'page_author' }

  // Nick nhà — TỰ ĐỘNG, chống lộ cụm. Đây là loại trừ quan trọng nhất.
  if (authorId && ctx.ownNicks.has(authorId)) return { ok: false, reason: 'own_nick' }

  // Đối thủ / blocklist
  if (authorId && ctx.competitorIds.has(authorId)) return { ok: false, reason: 'competitor_page' }
  if (authorId && ctx.blockedUsers.has(authorId)) return { ok: false, reason: 'blocked_user' }

  // Đã comment bài này rồi
  if (postId && ctx.commented.has(postId)) return { ok: false, reason: 'already_commented' }

  const normText = stripDiacritics(post.text)

  // Bài nhắc tên đối thủ
  for (const kw of ctx.competitorKeywords) {
    if (kw && normText.includes(kw)) return { ok: false, reason: `competitor_keyword:${kw}` }
  }

  // Chủ đề bị chặn (user tự thêm) + chủ đề nhạy cảm (mặc định)
  for (const kw of ctx.blockedTopics) {
    if (kw && matchesWholeWord(normText, kw)) return { ok: false, reason: `blocked_topic:${kw}` }
  }
  for (const kw of SENSITIVE_PATTERNS) {
    if (matchesWholeWord(normText, kw)) return { ok: false, reason: `sensitive_topic:${kw}` }
  }

  return { ok: true }
}

/**
 * TẦNG 1 — lọc thô từ khoá. Trả { ok, matched } hoặc { ok:false, reason }.
 * Bài phải khớp ≥1 target keyword VÀ không dính negative keyword.
 */
function matchKeywords(text, targetKeywords = [], negativeKeywords = []) {
  const norm = stripDiacritics(text)
  if (!norm.trim()) return { ok: false, reason: 'empty_text' }

  // Negative trước (loại nhanh)
  for (const nk of negativeKeywords) {
    const n = stripDiacritics(nk)
    if (n && norm.includes(n)) return { ok: false, reason: `negative_keyword:${nk}` }
  }

  // Phải khớp ít nhất 1 target keyword
  for (const tk of targetKeywords) {
    const t = stripDiacritics(tk)
    if (t && norm.includes(t)) return { ok: true, matched: tk }
  }
  return { ok: false, reason: 'no_keyword_match' }
}

// Widget/khối không phải bài viết thật — comment vào đây là vô nghĩa
const NOT_A_POST = [
  'nhung nguoi ban co the biet', 'people you may know',
  'trang goi y', 'nguoi lien he goi y', 'reels',
  'sinh nhat hom nay', 'ky niem cua ban',
].map(stripDiacritics)

// Bài NGOÀI mảng tech dù chứa từ khoá tech lẻ tẻ — tuyển dụng & quảng cáo game.
// User (19/08): tập trung chủ đề tech, bỏ qua tuyển dụng/game vì feed load liên
// tục có RẤT NHIỀU bài, không cần vơ bài ngoài ngách. Đã đo thật: 'server' khớp
// quảng cáo game "Thục Long", 'developer' khớp tin tuyển Java.
// High-precision: tránh 'tuyen ' trần (dính 'trực tuyến'=online), chỉ cụm rõ ràng.
const NON_TECH_NOISE = [
  // Tuyển dụng
  'tuyen dung', 'gui cv', 'ung vien', 'mo ta cong viec', 'ho tro pv',
  'we are hiring', 'hiring', 'jd:', 'quyen loi duoc huong',
  // Quảng cáo game
  'ra mat server', 'gift code', 'giftcode', 'nap the', 'top nap', 'tan thu',
].map(stripDiacritics)
function isNonTechNoise(normText) {
  for (const p of NON_TECH_NOISE) if (p && normText.includes(p)) return p
  return null
}

/**
 * Bài có đáng để comment kiểu "người dùng bình thường" không?
 * Dùng cho hạng general — không cần khớp từ khoá ngành.
 */
function isCommentable(post) {
  const text = post.text || ''
  if (text.length < 40) return { ok: false, reason: 'too_short' }
  const norm = stripDiacritics(text)
  for (const w of NOT_A_POST) {
    if (norm.includes(w)) return { ok: false, reason: `not_a_post:${w}` }
  }
  // Bài chỉ toàn link/mã, không có câu chữ thật
  const wordCount = text.split(/\s+/).filter(w => w.length > 2).length
  if (wordCount < 8) return { ok: false, reason: 'not_enough_words' }
  return { ok: true }
}

/**
 * Chạy Tầng 0 + Tầng 1 cho 1 bài.
 *
 * Trả về HẠNG thay vì cho/không cho:
 *   tier 'niche'    — khớp từ khoá ngành → ưu tiên cao, ĐƯỢC comment + cài quảng cáo
 *   tier 'interest' — khớp mảng "tech" rộng → CHỈ để LIKE/đọc (huấn luyện thuật
 *                     toán). feed-seed loại tier này khỏi comment (chỉ comment niche).
 *   tier 'general'  — không khớp gì nhưng vẫn là bài thật → tín hiệu yếu, ít like
 *   eligible false  — bị loại trừ cứng hoặc không phải bài viết thật
 *
 * Vì sao tách 'interest': feed cá nhân nghèo bài đúng ngách. Muốn Facebook đẩy
 * thêm bài VPS/Hosting thì phải NUÔI tín hiệu sở thích tech (like/đọc) nhiều ngày.
 * Nhưng comment thì vẫn chỉ nên đúng ngách hẹp — nên interest được like, KHÔNG
 * được comment. Quảng cáo vẫn bị chặn riêng bởi feed-ad-strategy.
 *
 * @returns { eligible, tier?, reason?, matched? }
 */
// ── WIDGET FEED, KHÔNG PHẢI BÀI VIẾT (25/08) ──────────────────────────────
// Facebook chèn thẻ gợi ý vào giữa newsfeed ("Gợi ý nhóm ... 189K thành viên
// • 10 bài/ngày", "Người bạn có thể biết", Reels...). Bộ trích coi chúng như
// bài (id tổng hợp syn_*) rồi cố LIKE → không có nút Like đúng → trượt và ghi
// like_failed:post_relocated. Đo thật 24h: 8/9 lượt like hỏng là loại này, cùng
// một thẻ syn_9rym6s trượt 3 lần. Like thẻ gợi ý cũng vô nghĩa với thuật toán.
// Nhóm MẠNH: câu chỉ xuất hiện trong widget, không ai viết trong bài thật.
const WIDGET_STRONG = [
  'nguoi ban co the biet', 'nhung nguoi ban co the biet', 'people you may know',
  'suggested for you', 'reels danh cho ban', 'trang goi y', 'suggested pages',
].map(stripDiacritics)

// Nhóm YẾU: cụm này người thật CŨNG viết ("mình muốn gợi ý nhóm này cho anh em"),
// nên chỉ tính là widget khi ĐI KÈM số liệu đặc trưng của thẻ gợi ý.
const WIDGET_WEAK = [
  'goi y nhom', 'goi y cho ban', 'suggested groups', 'nhom ban co the thich',
  'moi ban tham gia',
].map(stripDiacritics)

// Dấu hiệu số liệu chỉ có ở thẻ gợi ý: "189K thành viên", "10 bài/ngày"...
const WIDGET_STATS = [
  'thanh vien', 'member', 'bai/ngay', 'bai moi ngay', 'nguoi theo doi', 'followers',
].map(stripDiacritics)

function isFeedWidget(normText) {
  const head = (normText || "").slice(0, 120)
  for (const w of WIDGET_STRONG) {
    if (head.includes(w)) return w
  }
  const hasStats = WIDGET_STATS.some(x => head.includes(x))
  if (!hasStats) return null
  for (const w of WIDGET_WEAK) {
    if (head.includes(w)) return w
  }
  return null
}

function screenPost(post, ctx, niche) {
  const hard = passesHardExclusion(post, ctx)
  if (!hard.ok) return { eligible: false, reason: hard.reason }

  const negatives = (niche && niche.negative_keywords) || []
  const norm = stripDiacritics(post.text)
  for (const nk of negatives) {
    const n = stripDiacritics(nk)
    if (n && norm.includes(n)) return { eligible: false, reason: `negative_keyword:${nk}` }
  }

  // Thẻ gợi ý của Facebook — không phải bài, không like/comment được.
  const widget = isFeedWidget(norm)
  if (widget) return { eligible: false, reason: `feed_widget:${widget}` }

  // Loại bài tuyển dụng / quảng cáo game — ngoài mảng tech, không comment/like.
  const noise = isNonTechNoise(norm)
  if (noise) return { eligible: false, reason: `non_tech_noise:${noise}` }

  // Khớp từ khoá ngành → hạng niche (được comment)
  for (const tk of (niche && niche.target_keywords) || []) {
    const t = stripDiacritics(tk)
    if (t && norm.includes(t)) return { eligible: true, tier: 'niche', matched: tk }
  }

  // Khớp mảng tech rộng → hạng interest (chỉ like/đọc để dạy thuật toán).
  // KHÔNG qua isCommentable: bài tech ngắn vẫn like được — ta không comment nó.
  const aff = matchesAffinity(norm)
  if (aff) return { eligible: true, tier: 'interest', matched: aff }

  // Không khớp gì — vẫn là tín hiệu (yếu) nếu là bài thật
  const c = isCommentable(post)
  if (!c.ok) return { eligible: false, reason: c.reason }
  return { eligible: true, tier: 'general' }
}

/**
 * Bài/bình luận đang hiển thị BẢN DỊCH TỰ ĐỘNG của Facebook.
 *
 * Dùng cho nơi chỉ cầm được TEXT (không còn DOM node) — ví dụ nội dung reply
 * trong check_replies. feed-dom bắt chính xác hơn nhờ đọc cả node, nhưng nút
 * "Xem bản dịch" là div[dir="auto"] nên thường lọt luôn vào text gom được.
 *
 * Có dấu này = bản gốc KHÔNG PHẢI tiếng Việt → đừng trả lời/comment tiếng Việt.
 */
const TRANSLATED_MARKERS = /ẩn bản gốc|xem bản gốc|xem bản dịch|bản dịch|đã dịch|được dịch|đánh giá bản dịch|see translation|see original|translated from|translated by facebook|automatically translated|rate this translation/i

function looksTranslated(text) {
  return TRANSLATED_MARKERS.test(text || '')
}

module.exports = {
  stripDiacritics,
  SENSITIVE_PATTERNS,
  TRANSLATED_MARKERS,
  looksTranslated,
  TECH_AFFINITY,
  HIGH_AFFINITY,
  isHighAffinity,
  matchesAffinity,
  isFeedWidget,
  isVietnamese,
  buildExclusionContext,
  passesHardExclusion,
  matchKeywords,
  screenPost,
}
