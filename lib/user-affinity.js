/**
 * user-affinity.js — Lexicon ngách PER-USER, do AI phân tích context sinh ra.
 *
 * VÌ SAO TỒN TẠI (04/09, user: "từ khoá được hiểu theo AI phân tích context để
 * giao nhiệm vụ cho user, đây là hệ thống saas nên cần độc lập giữa các user"):
 * TECH_AFFINITY / HIGH_AFFINITY trong feed-filter là hằng TOÀN CỤC viết tay cho
 * ngách VPS — mọi user đều bị soi feed qua lăng kính VPS. User bán mỹ phẩm sẽ
 * bị hệ thống like bài docker và bỏ qua bài skincare. SaaS thì lexicon phải
 * sinh TỪ CẤU HÌNH CỦA TỪNG USER (niche/persona/target_keywords/products).
 *
 * Kiến trúc:
 *   getAffinity(niche, supabase) → { high: Set, all: string[], source }
 *   - Cache: niche_profiles.ai_affinity (jsonb {high[], related[]}) + ai_affinity_at,
 *     tươi 7 ngày. Đổi cấu hình ngách → chạy lại sau khi cache hết hạn (hoặc
 *     xoá ai_affinity_at để ép sinh lại ngay).
 *   - Sinh mới: AI (hermes, task relevance_score) đọc TOÀN BỘ context ngách và
 *     trả {high, related} — high = sát ngách (ưu tiên comment/quảng cáo),
 *     related = kề ngách (like/nuôi thuật toán).
 *   - Fail-safe TẤT ĐỊNH: AI hỏng → high = target_keywords + từ khoá sản phẩm,
 *     related = thêm từ moi từ mô tả brand. Không bao giờ trả rỗng nếu user có
 *     cấu hình. User ngách tech (niche khớp vps/hosting/server/tech) được merge
 *     thêm bộ legacy để không tụt chất lượng so với trước.
 *
 * feed-filter KHÔNG require file này (nhận affinity qua THAM SỐ) — tránh vòng.
 * Mọi từ đều stripDiacritics trước khi so (khớp quy ước feed-filter).
 */

const { stripDiacritics, TECH_AFFINITY, HIGH_AFFINITY } = require('./feed-filter')

const CACHE_TTL_MS = 7 * 24 * 3600 * 1000
const FAIL_RETRY_MS = 6 * 3600 * 1000   // AI hỏng → thử lại sau 6h, không phải mỗi phiên
const _mem = new Map()   // account_id → { aff, at } — đỡ query DB mỗi phiên

/** Lexicon tất định từ cấu hình tay của user — nền và lưới an toàn. */
function buildDeterministic(niche = {}) {
  const high = new Set()
  const related = new Set()
  for (const k of niche.target_keywords || []) {
    const s = stripDiacritics(String(k || '').toLowerCase().trim())
    if (s) high.add(s)
  }
  for (const p of niche.products || []) {
    for (const k of [p?.name, ...(p?.keywords || [])]) {
      const s = stripDiacritics(String(k || '').toLowerCase().trim())
      if (s && s.length >= 3) high.add(s)
    }
  }
  // Từ đơn dài >=4 ký tự trong tên ngách — "VPS & Hosting Việt Nam" → vps, hosting
  for (const w of String(niche.niche || '').split(/[^\p{L}\p{N}]+/u)) {
    const s = stripDiacritics(w.toLowerCase())
    if (s.length >= 4) related.add(s)
  }
  // Ngách thuộc mảng tech → merge bộ legacy (đã tinh chỉnh nhiều tháng) để user
  // tech không tụt chất so với thời hằng toàn cục.
  const nicheNorm = stripDiacritics(String(niche.niche || '') + ' ' + String(niche.brand_description || ''))
  if (/vps|hosting|server|may chu|cloud|tech|cong nghe|phan mem|software|devops/.test(nicheNorm)) {
    for (const k of HIGH_AFFINITY) high.add(k)
    for (const k of TECH_AFFINITY) related.add(k)
  }
  return { high, related }
}

function toAff(highArr, relatedArr, source) {
  const high = new Set()
  const all = []
  const seen = new Set()
  for (const k of highArr) {
    const s = stripDiacritics(String(k || '').toLowerCase().trim())
    if (s && s.length >= 3 && !seen.has(s)) { seen.add(s); high.add(s); all.push(s) }
  }
  for (const k of relatedArr) {
    const s = stripDiacritics(String(k || '').toLowerCase().trim())
    if (s && s.length >= 3 && !seen.has(s)) { seen.add(s); all.push(s) }
  }
  return { high, all, source }
}

/** Sinh lexicon bằng AI đọc context ngách. Ném lỗi khi AI hỏng — caller lo fallback. */
async function aiExpand(niche) {
  // require tại chỗ, tránh nạp ai-brain (nặng) khi chỉ cần fallback tất định
  const { callAI } = require('./ai-brain')
  const ctx = {
    nganh: niche.niche || '',
    persona: (niche.persona || '').slice(0, 300),
    tu_khoa: niche.target_keywords || [],
    san_pham: (niche.products || []).map(p => ({ ten: p?.name, mo_ta: (p?.description || '').slice(0, 150), tu_khoa: p?.keywords })),
    brand: niche.brand_name || '',
    mo_ta_brand: (niche.brand_description || '').slice(0, 300),
  }
  const prompt = `Bạn phân tích NGÁCH kinh doanh của một người dùng mạng xã hội để hệ thống biết bài viết nào đáng tương tác.

CONTEXT NGÁCH (JSON):
${JSON.stringify(ctx)}

Sinh 2 danh sách từ khoá TIẾNG VIỆT KHÔNG DẤU (kèm thuật ngữ tiếng Anh thông dụng của ngách):
- "high": 25-40 từ/cụm SÁT ngách — người có nhu cầu mua/dùng sản phẩm này sẽ nhắc tới (ưu tiên comment + quảng cáo)
- "related": 25-40 từ/cụm KỀ ngách — cùng hệ sinh thái, người trong ngách quan tâm (chỉ like/đọc để nuôi thuật toán)

Quy tắc: cụm 1-3 từ, ĐẶC TRƯNG cho ngách (tránh từ đơn mơ hồ dính nhiều nghĩa), không trùng nhau giữa 2 danh sách.
Chỉ trả JSON: {"high": [...], "related": [...]}`
  const text = await callAI({ taskType: 'relevance_score', prompt, maxTokens: 900, temperature: 0.3, ownerId: niche.user_id })
  const m = String(text).match(/\{[\s\S]*\}/)
  if (!m) throw new Error('ai_affinity: AI không trả JSON')
  const j = JSON.parse(m[0])
  if (!Array.isArray(j.high) || !j.high.length) throw new Error('ai_affinity: thiếu danh sách high')
  return { high: j.high, related: Array.isArray(j.related) ? j.related : [] }
}

/**
 * Lexicon per-user — cache RAM → cache DB → AI sinh mới → fallback tất định.
 * Luôn merge fallback tất định vào kết quả AI (từ khoá user gõ tay là mệnh lệnh,
 * AI chỉ MỞ RỘNG chứ không được làm rơi).
 */
async function getAffinity(niche, supabase = null) {
  if (!niche) return toAff([...HIGH_AFFINITY], TECH_AFFINITY, 'legacy_global')
  const key = niche.account_id || niche.id || 'anon'

  const hit = _mem.get(key)
  if (hit && Date.now() - hit.at < 30 * 60 * 1000) return hit.aff

  const det = buildDeterministic(niche)
  let aff = null

  const cached = niche.ai_affinity
  const cachedAt = niche.ai_affinity_at ? new Date(niche.ai_affinity_at).getTime() : 0
  const tuoi = Date.now() - cachedAt
  if (cached && Array.isArray(cached.high) && cached.high.length && tuoi < CACHE_TTL_MS) {
    aff = toAff([...cached.high, ...det.high], [...(cached.related || []), ...det.related], 'ai_cache')
  } else if (cached && cached.failed && tuoi < FAIL_RETRY_MS) {
    // AI vừa hỏng gần đây — KHÔNG gọi lại mỗi phiên (đo 04/09: mỗi phiên feed
    // đốt ~60s chờ hermes 500 trước khi làm việc). Dùng tất định, thử lại sau 6h.
    aff = toAff([...det.high], [...det.related], 'deterministic_cached_fail')
  } else {
    try {
      const j = await aiExpand(niche)
      aff = toAff([...j.high, ...det.high], [...j.related, ...det.related], 'ai_fresh')
      if (supabase && (niche.id || niche.account_id)) {
        const q = supabase.from('niche_profiles')
          .update({ ai_affinity: { high: j.high, related: j.related }, ai_affinity_at: new Date().toISOString() })
        await (niche.id ? q.eq('id', niche.id) : q.eq('account_id', niche.account_id))
        console.log(`[AFFINITY] AI sinh lexicon mới cho ngách "${niche.niche}": ${j.high.length} high + ${j.related.length} related`)
      }
    } catch (e) {
      console.warn(`[AFFINITY] AI expand hỏng (${e.message}) — dùng lexicon tất định từ cấu hình user`)
      aff = toAff([...det.high], [...det.related], 'deterministic')
      // Ghi dấu thất bại để các phiên tới không tốn 60s gọi lại (thử lại sau 6h)
      if (supabase && (niche.id || niche.account_id)) {
        try {
          const q = supabase.from('niche_profiles')
            .update({ ai_affinity: { failed: true, high: [], related: [], error: String(e.message).slice(0, 120) }, ai_affinity_at: new Date().toISOString() })
          await (niche.id ? q.eq('id', niche.id) : q.eq('account_id', niche.account_id))
        } catch {}
      }
    }
  }

  _mem.set(key, { aff, at: Date.now() })
  return aff
}

module.exports = { getAffinity, buildDeterministic, aiExpand, toAff }
