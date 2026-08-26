/**
 * health-check.js — Bắt LỖI IM LẶNG của SocialFlow.
 *
 * Khác watchdog.js: watchdog lo agent CÒN SỐNG; script này lo agent CÒN ĐÚNG.
 * Mọi bug nặng nhất từ trước tới nay đều thuộc loại job vẫn báo `done` nhưng
 * chẳng làm gì — nurture_feed `posts_seen=2` suốt 9 phiên, scan_group
 * `posts_found=0` suốt 17 phiên, feed_seed `ads=0` cả tuần, comment sinh ra
 * bằng model tiếng Việt kém. Không có gì báo động; chỉ phát hiện khi ngồi
 * query tay. Mỗi mục dưới đây là MỘT bug đã xảy ra thật, viết lại thành bất
 * biến kiểm được — tái phát là kêu ngay.
 *
 * Dùng:
 *   node scripts/health-check.js           chỉ kiểm tra và báo
 *   node scripts/health-check.js --heal    chữa thêm những mục AN TOÀN (xem checkStuckJobs)
 *   node scripts/health-check.js --json    in JSON (cho Task Scheduler/giám sát)
 *
 * Exit code: 0 = ổn (hoặc chỉ cảnh báo), 1 = có lỗi, 2 = script hỏng.
 *
 * KHÔNG tự sửa code. Sửa code là việc của người — script chỉ sửa DỮ LIỆU ở
 * những chỗ đã chứng minh an toàn, và ghi rõ đã sửa gì.
 */
const path = require('path')
const fs = require('fs')
require('dotenv').config({ path: path.join(__dirname, '..', '.env') })
const { Client } = require('pg')
const { isVietnamese } = require('../lib/feed-filter')

const HEAL = process.argv.includes('--heal')
const AS_JSON = process.argv.includes('--json')
const LOG = path.join(__dirname, '..', 'health-check.log')

const checks = []
const healed = []
const add = (level, name, msg, detail) => checks.push({ level, name, msg, detail })
const ok = (name, msg, d) => add('OK', name, msg, d)
const warn = (name, msg, d) => add('WARN', name, msg, d)
const fail = (name, msg, d) => add('FAIL', name, msg, d)

/** Job gần nhất theo loại, kèm result đã parse sẵn. */
async function recentJobs(c, type, n = 5, hours = 24) {
  const r = await c.query(
    `SELECT id, status, finished_at, result, error_message FROM jobs
     WHERE type = $1 AND finished_at > now() - ($2 || ' hours')::interval
     ORDER BY finished_at DESC LIMIT $3`, [type, String(hours), n])
  return r.rows
}
const num = (v) => (typeof v === 'number' ? v : Number(v) || 0)
const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)

// ─────────────────────────────────────────────────────────────
// 1. nurture_feed có THỰC SỰ nhìn thấy bài không
//    Bug 25/08: quét bằng [role="article"] — trên newsfeed đó là comment, không
//    phải bài → posts_seen=2 suốt 9 phiên, reacts=0, vẫn mở browser 40s mỗi phiên.
async function checkNurtureFeed(c) {
  const js = await recentJobs(c, 'nurture_feed', 6)
  if (!js.length) return warn('nurture_feed', 'không có phiên nào trong 24h — cron phía server có chạy không?')
  const seen = js.map(j => num(j.result && j.result.posts_seen))
  const reacts = js.map(j => num(j.result && j.result.reacts))
  const m = avg(seen)
  const d = { phien: js.length, posts_seen_tb: +m.toFixed(1), reacts_tong: reacts.reduce((a, b) => a + b, 0) }
  if (m < 3) return fail('nurture_feed', `chỉ thấy trung bình ${m.toFixed(1)} bài/phiên — bộ quét DOM hỏng (xem browser/feed-dom.js)`, d)
  if (d.reacts_tong === 0) return warn('nurture_feed', `thấy bài nhưng KHÔNG like lượt nào trong ${js.length} phiên`, d)
  ok('nurture_feed', `${m.toFixed(1)} bài/phiên, ${d.reacts_tong} like`, d)
}

// ─────────────────────────────────────────────────────────────
// 2. feed_seed còn sinh được comment không
//    Bug: candidates tụt về 0 khi Facebook đổi DOM hoặc bộ lọc siết quá tay.
async function checkFeedSeed(c) {
  const js = await recentJobs(c, 'feed_seed', 5)
  if (!js.length) return warn('feed_seed', 'không có phiên nào trong 24h')
  const scanned = avg(js.map(j => num(j.result && j.result.posts_scanned)))
  const queued = js.map(j => num(j.result && j.result.queued)).reduce((a, b) => a + b, 0)
  const cands = avg(js.map(j => num(j.result && j.result.candidates)))
  const d = { phien: js.length, quet_tb: +scanned.toFixed(1), ungvien_tb: +cands.toFixed(1), xephang_tong: queued }

  if (scanned < 10) fail('feed_seed', `chỉ quét ${scanned.toFixed(1)} bài/phiên — feed không tải được hoặc DOM đổi`, d)
  else if (queued === 0) fail('feed_seed', `${js.length} phiên liên tiếp KHÔNG xếp được comment nào`, d)
  else if (cands < 1.5) warn('feed_seed', `chỉ ${cands.toFixed(1)} ứng viên/phiên — bộ lọc đang siết rất chặt`, d)
  else ok('feed_seed', `quét ${scanned.toFixed(0)}, ${cands.toFixed(1)} ứng viên/phiên, xếp ${queued} comment`, d)

  // Cửa lọc nào đang nuốt bài — chỉ kêu khi MỘT cửa chiếm quá nửa.
  const drops = {}
  for (const j of js) for (const [k, v] of Object.entries((j.result && j.result.filter_drop) || {})) drops[k] = (drops[k] || 0) + num(v)
  const tong = Object.values(drops).reduce((a, b) => a + b, 0)
  if (tong > 0) {
    const [top, n] = Object.entries(drops).sort((a, b) => b[1] - a[1])[0]
    if (n / tong > 0.5) warn('feed_seed_loc', `cửa "${top}" một mình loại ${n}/${tong} bài (${(n / tong * 100).toFixed(0)}%)`, drops)
    else ok('feed_seed_loc', `phân bố cửa lọc bình thường (nhiều nhất: ${top}=${n}/${tong})`, drops)
  }

  // Gate chất lượng siết oan: ngưỡng fluency từng được nâng lúc model còn kém,
  // đổi sang model tốt rồi mà không hạ lại thì comment tốt cũng bị giết.
  const gen = {}
  for (const j of js) for (const [k, v] of Object.entries((j.result && j.result.gen_reject) || {})) gen[k] = (gen[k] || 0) + num(v)
  const genTong = Object.values(gen).reduce((a, b) => a + b, 0)
  if (genTong >= 4 && (gen.quality_gate || 0) / genTong > 0.6) {
    warn('quality_gate', `gate loại ${gen.quality_gate}/${genTong} comment — cân nhắc hạ ngưỡng fluency trong lib/ai-brain.js`, gen)
  } else if (genTong > 0) ok('quality_gate', `loại ${genTong} comment khi sinh`, gen)
}

// ─────────────────────────────────────────────────────────────
// 3. feed_scroll còn like được không
//    Bug: widget gợi ý bị coi là bài → like trượt (post_relocated).
async function checkFeedScroll(c) {
  const js = await recentJobs(c, 'feed_scroll', 5)
  if (!js.length) return warn('feed_scroll', 'không có phiên nào trong 24h')
  const liked = js.map(j => num(j.result && j.result.posts_liked)).reduce((a, b) => a + b, 0)
  const scanned = avg(js.map(j => num(j.result && j.result.posts_scanned)))
  const d = { phien: js.length, like_tong: liked, quet_tb: +scanned.toFixed(1) }
  if (liked === 0) return fail('feed_scroll', `${js.length} phiên KHÔNG like được bài nào`, d)
  ok('feed_scroll', `${liked} like / ${js.length} phiên`, d)
}

// ─────────────────────────────────────────────────────────────
// 4. Model AI đang dùng có đúng không
//    Bug 25/08: model thật = fallback_chain[0] của hermes_config THEO USER,
//    không phải cfg.model (dòng log nói dối). Từng chạy openai/gpt-oss-120b →
//    tiếng Việt sai bét ("hiệu năng ngăn hơn"). Kiểm để không bị đổi ngược.
async function checkAiModel(c) {
  const r = await c.query('SELECT id, user_id, config FROM hermes_config WHERE user_id IS NOT NULL')
  const xau = []
  for (const row of r.rows) {
    const cfg = row.config || {}
    const chain = (cfg.fallback_chain || []).filter(p => p && p.enabled)
    const dau = chain[0]
    if (!dau) { xau.push({ row: row.id, ly_do: 'fallback_chain rỗng' }) }
    else if (/v4-flash|deepseek-r1|thinking|-o1|o3-|qwq/i.test(dau.model || '')) {
      // Model reasoning đốt hết token vào reasoning_content, trả content RỖNG
      // → comment trắng. Không bao giờ được đứng đầu chuỗi.
      xau.push({ row: row.id, ly_do: `model reasoning "${dau.model}" đứng đầu chuỗi — sẽ trả comment rỗng` })
    } else if (/gpt-oss/i.test(dau.model || '')) {
      xau.push({ row: row.id, ly_do: `"${dau.model}" tiếng Việt kém — nên dùng deepseek-chat` })
    }
    if (Array.isArray(cfg.fallback_keys)) {
      xau.push({ row: row.id, ly_do: 'fallback_keys là MẢNG, code đọc bằng .get() nên mọi key rơi về biến môi trường' })
    }
  }
  if (xau.length) return fail('ai_model', `${xau.length} cấu hình AI có vấn đề`, xau)
  ok('ai_model', `${r.rows.length} cấu hình AI đều dùng model chat bình thường`)
}

// ─────────────────────────────────────────────────────────────
// 5. Comment đăng ra có đúng tiếng Việt không
//    Bug: Facebook tự dịch bài ngoại ngữ sang tiếng Việt ngay trên feed → bộ
//    lọc tưởng bài tiếng Việt → nick comment tiếng Việt dưới bài tiếng Bồ.
async function checkCommentLanguage(c) {
  const r = await c.query(
    `SELECT comment_text, post_url, created_at FROM comment_logs
     WHERE status = 'done' AND created_at > now() - interval '24 hours'
     ORDER BY created_at DESC LIMIT 40`)
  if (!r.rows.length) return warn('comment_lang', 'không có comment nào trong 24h')
  const xau = r.rows.filter(x => x.comment_text && x.comment_text.length > 12 && !isVietnamese(x.comment_text))
  const d = { tong: r.rows.length, khong_viet: xau.length, vi_du: xau.slice(0, 3).map(x => x.comment_text.slice(0, 70)) }
  if (xau.length / r.rows.length > 0.15) return fail('comment_lang', `${xau.length}/${r.rows.length} comment không phải tiếng Việt`, d)
  if (xau.length) return warn('comment_lang', `${xau.length}/${r.rows.length} comment đáng ngờ về ngôn ngữ`, d)
  ok('comment_lang', `${r.rows.length} comment đều tiếng Việt`)
}

// ─────────────────────────────────────────────────────────────
// 6. Job có bị kẹt không
//    CHỮA (--heal): job quá hạn lâu mà chưa ai nhận → đẩy hạn về hiện tại để
//    poller lấy ngay. An toàn: không đổi payload, không tạo hành động mới.
async function checkStuckJobs(c) {
  const r = await c.query(
    `SELECT id, type, scheduled_at, priority FROM jobs
     WHERE status = 'pending' AND scheduled_at < now() - interval '2 hours'
     ORDER BY scheduled_at LIMIT 30`)
  if (!r.rows.length) return ok('job_ket', 'không job nào quá hạn')
  const d = r.rows.map(x => ({ type: x.type, tre_phut: Math.round((Date.now() - new Date(x.scheduled_at)) / 60000) }))
  if (HEAL) {
    const ids = r.rows.map(x => x.id)
    await c.query(`UPDATE jobs SET scheduled_at = now() WHERE id = ANY($1) AND status = 'pending'`, [ids])
    healed.push(`đẩy ${ids.length} job quá hạn về hiện tại`)
    return warn('job_ket', `${r.rows.length} job quá hạn — ĐÃ đẩy về hiện tại`, d)
  }
  warn('job_ket', `${r.rows.length} job quá hạn >2h (chạy với --heal để đánh thức)`, d)
}

// ─────────────────────────────────────────────────────────────
// 7. Job chết vì hết giờ — HAI bệnh khác hẳn nhau, đừng gộp:
//
//    a) CHẠY quá giờ (started_at có, "execution exceeded 10m") → lỗi HANDLER:
//       không tôn trọng deadline, phải sửa code handler.
//    b) CHỜ quá lâu chưa ai nhận (started_at NULL, "stale_pending") → lỗi
//       HÀNG ĐỢI: nick quá bận hoặc job xếp dày hơn sức chạy. Sửa bằng cách
//       giãn lịch/nâng ưu tiên, không phải sửa handler.
//    Gộp hai loại lại thì mỗi lần báo động đều dẫn đi sai hướng.
async function checkTimeouts(c) {
  const r = await c.query(
    `SELECT type,
            count(*) FILTER (WHERE started_at IS NOT NULL) chay_qua_gio,
            count(*) FILTER (WHERE started_at IS NULL)     cho_qua_lau
     FROM jobs
     WHERE status = 'cancelled' AND created_at > now() - interval '24 hours'
       AND error_message ILIKE '%timeout%'
     GROUP BY 1`)
  const chay = {}, cho = {}
  for (const x of r.rows) {
    if (Number(x.chay_qua_gio)) chay[x.type] = Number(x.chay_qua_gio)
    if (Number(x.cho_qua_lau)) cho[x.type] = Number(x.cho_qua_lau)
  }
  const nChay = Object.values(chay).reduce((a, b) => a + b, 0)
  const nCho = Object.values(cho).reduce((a, b) => a + b, 0)

  if (nChay >= 3) fail('timeout_chay', `${nChay} job CHẠY quá 10 phút — handler chưa tôn trọng deadline`, chay)
  else if (nChay) warn('timeout_chay', `${nChay} job chạy quá giờ`, chay)
  else ok('timeout_chay', 'không job nào chạy quá giờ')

  // Job feed bị bỏ đói đáng lo hơn hẳn: newsfeed là nhiệm vụ chính, mỗi phiên
  // lỡ là mất nguyên khung giờ chứ không chạy bù được.
  const choFeed = Object.entries(cho).filter(([t]) => t.startsWith('feed') || t === 'nurture_feed')
    .reduce((a, [, n]) => a + n, 0)
  if (choFeed) fail('timeout_cho', `${choFeed} job FEED bị bỏ đói (chưa từng chạy) — hàng đợi quá tải`, cho)
  else if (nCho >= 4) warn('timeout_cho', `${nCho} job chờ quá lâu chưa ai nhận — hàng đợi đang quá tải`, cho)
  else if (nCho) ok('timeout_cho', `${nCho} job chờ quá lâu (dưới ngưỡng đáng lo)`, cho)
  else ok('timeout_cho', 'không job nào bị bỏ đói')
}

// ─────────────────────────────────────────────────────────────
// 8. Nick còn khoẻ không
async function checkNicks(c) {
  const r = await c.query(
    `SELECT id, username, status FROM accounts
     WHERE status IS DISTINCT FROM 'deleted' ORDER BY username`)
  if (!r.rows.length) return fail('nick', 'không có nick nào')
  const om = r.rows.filter(x => x.status && !['healthy', 'active'].includes(x.status))
  const d = { tong: r.rows.length, khong_khoe: om.map(x => `${x.username}:${x.status}`) }
  if (om.length) return warn('nick', `${om.length}/${r.rows.length} nick không ở trạng thái healthy`, d)
  ok('nick', `${r.rows.length} nick đều healthy`, d)
}

// ─────────────────────────────────────────────────────────────
// 9. Vòng TRẢ LỜI có sống không
//    Bug 25/08: 16/16 phiên check_replies trong 24h đều `own_comment_not_found`
//    → 0 reply. Job vẫn `done`, không ai biết vòng hội thoại đã chết.
async function checkReplyLoop(c) {
  const js = await recentJobs(c, 'check_replies', 8)
  if (!js.length) return warn('vong_reply', 'không có phiên check_replies nào trong 24h')
  const replied = js.map(j => num(j.result && j.result.replied)).reduce((a, b) => a + b, 0)
  const found = js.map(j => num(j.result && j.result.replies_found)).reduce((a, b) => a + b, 0)

  // ĐẾM THEO TARGET, KHÔNG THEO PHIÊN.
  //
  // Bản đầu đếm "phiên có ít nhất 1 target hỏng" → 7/8 phiên → báo FAIL "khâu
  // tìm thread hỏng". Sai hẳn: đo lại theo target thì chỉ 18/98 target (18%)
  // hỏng, 82% tìm thấy comment bình thường. Một target hỏng trong phiên 10
  // target không có nghĩa là cả cơ chế chết — ngưỡng theo phiên gần như luôn
  // chạm khi mỗi phiên xử lý nhiều target.
  let target = 0, hong = 0
  for (const j of js) {
    target += num(j.result && j.result.checked)
    hong += ((j.result && j.result.skipped) || [])
      .filter(s => String(s).startsWith('own_comment_not_found')).length
  }
  const tyLe = target ? hong / target : 0
  const d = { phien: js.length, target, khong_thay_comment_minh: hong,
              ty_le_hong: `${(tyLe * 100).toFixed(0)}%`, tim_thay_reply: found, da_dap: replied }

  if (target >= 20 && tyLe > 0.5) {
    return fail('vong_reply', `${hong}/${target} target (${(tyLe * 100).toFixed(0)}%) không định vị được comment của nick — khâu tìm thread hỏng`, d)
  }
  if (target >= 20 && tyLe > 0.25) {
    warn('vong_reply', `${(tyLe * 100).toFixed(0)}% target không tìm thấy comment của nick`, d)
  }
  // Chưa ai trả lời là chuyện BÌNH THƯỜNG, không phải lỗi — đừng báo động.
  if (found === 0) return ok('vong_reply', `${target} target, chưa ai trả lời (bình thường), ${hong} target lỗi định vị`, d)
  if (replied === 0) return fail('vong_reply', `thấy ${found} reply nhưng KHÔNG đáp được cái nào`, d)
  ok('vong_reply', `đáp ${replied}/${found} reply qua ${js.length} phiên`, d)
}

// ─────────────────────────────────────────────────────────────
// 10. Cơ chế TỰ ĐÁNH GIÁ có còn chạy không
//     Bug: cron self_reviewer chết 9 ngày liền ("unparseable JSON") — hệ thống
//     mất khả năng tự học mà không có gì báo. Đây là thứ im lặng nhất trong
//     tất cả: không job nào failed, không nick nào sao, chỉ là hết tiến hoá.
async function checkSelfReview(c) {
  const r = await c.query(
    `SELECT max(created_at) last, count(*) FILTER (WHERE ok = false) loi
     FROM hermes_calls WHERE task_type = 'self_reviewer' AND created_at > now() - interval '7 days'`)
  const last = r.rows[0] && r.rows[0].last
  if (!last) return fail('tu_danh_gia', 'không chạy lần nào trong 7 ngày — cron self_reviewer đã chết')
  const gioTruoc = (Date.now() - new Date(last)) / 3600000
  const d = { lan_cuoi: new Date(last).toISOString().slice(0, 16), gio_truoc: Math.round(gioTruoc) }
  if (gioTruoc > 48) return fail('tu_danh_gia', `lần cuối cách đây ${Math.round(gioTruoc)}h — cron hằng ngày không chạy`, d)
  ok('tu_danh_gia', `chạy ${Math.round(gioTruoc)}h trước`, d)
}

// ─────────────────────────────────────────────────────────────
async function main() {
  const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: false })
  await c.connect()
  const all = [checkNurtureFeed, checkFeedSeed, checkFeedScroll, checkAiModel,
               checkCommentLanguage, checkStuckJobs, checkTimeouts, checkNicks,
               checkReplyLoop, checkSelfReview]
  for (const fn of all) {
    try { await fn(c) } catch (e) { fail(fn.name, 'kiểm tra lỗi: ' + e.message) }
  }
  await c.end()

  const fails = checks.filter(x => x.level === 'FAIL')
  const warns = checks.filter(x => x.level === 'WARN')
  const stamp = new Date().toISOString()

  if (AS_JSON) {
    console.log(JSON.stringify({ stamp, fails: fails.length, warns: warns.length, healed, checks }, null, 1))
  } else {
    const icon = { OK: 'OK  ', WARN: 'CANH', FAIL: 'LOI ' }
    console.log(`\n=== SocialFlow health-check ${stamp.slice(0, 19)} ===`)
    for (const x of checks) {
      console.log(`${icon[x.level]} ${x.name.padEnd(16)} ${x.msg}`)
      if (x.detail && x.level !== 'OK') console.log('       ' + JSON.stringify(x.detail))
    }
    for (const h of healed) console.log(`CHUA ${h}`)
    console.log(`--- ${fails.length} lỗi, ${warns.length} cảnh báo, ${checks.length - fails.length - warns.length} ổn ---`)
  }

  try {
    fs.appendFileSync(LOG, `${stamp} fails=${fails.length} warns=${warns.length}` +
      (fails.length ? ' | ' + fails.map(f => `${f.name}: ${f.msg}`).join(' ; ') : '') +
      (healed.length ? ' | CHUA: ' + healed.join(' ; ') : '') + '\n')
  } catch {}

  process.exit(fails.length ? 1 : 0)
}

main().catch(e => { console.error('health-check hỏng:', e.message); process.exit(2) })
