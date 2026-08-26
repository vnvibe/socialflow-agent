/**
 * check-replies.js — Vòng "TÌM & TRẢ LỜI": phát hiện người trả lời comment của
 * nick rồi đáp lại — không để hội thoại treo (user 22/08).
 *
 * Payload: { account_id, targets: [{ fb_post_id, post_url, comment_text }] }
 *   targets = các comment nick đã đăng (mined từ comment_logs bởi cron VPS
 *   nurture-scheduler mỗi 3h, comment done 2h-48h trước).
 *
 * Mỗi target: goto permalink → trích thread ([role=article] lồng nhau, pattern
 * đã kiểm chứng ở scan-group.js) → định vị comment CỦA NICK (khớp prefix text)
 * → gom reply nằm dưới nó (không phải của chính nick) → lọc an toàn → sinh trả
 * lời bằng hermes.generateReply (reply_gen, persona voice sẵn phía server) →
 * click "Trả lời" + gõ + Enter → ledger vào comment_logs (source_name='reply',
 * fb_post_id = comment_fb_id CỦA REPLY được trả lời → unique index
 * (account_id, fb_post_id) WHERE done thành cơ chế dedup miễn phí).
 *
 * FAIL-SOFT từng target: DOM đổi/không tìm thấy → skip target đó, không chết
 * cả job. Trần an toàn: HARD_LIMITS.reply (10/ngày, 3/phiên, gap ≥120s).
 */

const guard = require('../../lib/checkpoint-guard')
const { recordSignal } = require('../../lib/signal-collector')
const { getPage, releaseSession } = require('../../browser/session-pool')
const { humanMouseMove } = require('../../browser/human')
const { getBlockDetectionScript } = require('../../lib/block-detector')
const { SessionTracker, checkHardLimit } = require('../../lib/hard-limits')
const { SENSITIVE_PATTERNS, stripDiacritics, isVietnamese, looksTranslated } = require('../../lib/feed-filter')
const { looksLikeMetaOutput } = require('../../lib/ai-comment')
const hermes = require('../../lib/hermes-client')
const R = require('../../lib/randomizer')

const norm = (s) => (s || '').replace(/\s+/g, ' ').trim()

async function checkReplies(payload, supabase) {
  const { account_id, targets = [], job_id, dry_run = false } = payload || {}
  if (!account_id) throw new Error('account_id is required for checkReplies')
  if (!targets.length) return { success: true, checked: 0, replies_found: 0, replied: 0, note: 'no_targets' }

  const { data: account } = await supabase
    .from('accounts').select('*, proxies(*)').eq('id', account_id).single()
  if (!account) throw new Error('Account not found')
  if (['at_risk', 'checkpoint', 'disabled', 'banned'].includes(account.status) || account.is_active === false) {
    throw new Error(`SKIP_nick_paused: ${account.status}`)
  }

  // Trần ngày cho hành động reply
  const replyBudget = account.daily_budget?.reply || { used: 0 }
  const chk = checkHardLimit('reply', replyBudget.used, 0)
  if (!chk.allowed) throw new Error('SKIP_reply_limit_reached')

  const tracker = new SessionTracker()
  const deadline = Date.now() + 7 * 60 * 1000   // biên 3 phút dưới ngưỡng poller huỷ 10 phút
  const stats = { checked: 0, replies_found: 0, replied: 0, skipped: [], diag: [] }
  let page = null

  try {
    const sess = await getPage(account)
    page = sess.page

    for (const target of targets.slice(0, 10)) {
      if (Date.now() > deadline) { stats.skipped.push('deadline'); break }
      if (tracker.get('reply') >= 3) break   // maxPerSession
      if (!target.post_url) continue
      stats.checked++

      try {
        await page.goto(target.post_url, { waitUntil: 'domcontentloaded', timeout: 45000 })
        await R.sleepRange(3000, 6000)

        // Cầu dao: phát hiện chặn trước khi làm gì
        const blocked = await page.evaluate(getBlockDetectionScript())
        if (blocked.blocked) {
          await guard.tripBreaker(supabase, account_id, `reply_block:${blocked.reason}`, {
            jobId: job_id, ownerId: account.owner_id, recordSignal,
          })
          throw new Error(`CIRCUIT_BREAKER_TRIPPED: reply_block:${blocked.reason}`)
        }
        await humanMouseMove(page)

        // BUNG comment trước khi quét — với post URL (không phải permalink
        // comment), FB thu gọn comment theo "phù hợp nhất" nên comment của nick
        // thường KHÔNG có trong DOM (đo thật test #2: 2/3 own_comment_not_found).
        // Click "Xem thêm bình luận"/"View more comments" tối đa 3 lần.
        for (let ex = 0; ex < 3; ex++) {
          const expanded = await page.evaluate(() => {
            const el = Array.from(document.querySelectorAll('div[role="button"], span[role="button"], a'))
              .find(b => /xem thêm bình luận|view more comments|bình luận trước|previous comments|xem tất cả/i.test((b.textContent || '').trim()))
            if (el) { el.click(); return true }
            return false
          }).catch(() => false)
          if (!expanded) break
          await R.sleepRange(2000, 3500)
        }

        // ── Trích thread: comment của nick + các reply dưới nó ──
        const ownPrefix = norm(target.comment_text).slice(0, 40)
        // Playwright evaluate chỉ nhận 1 tham số → gói vào object
        const thread = await page.evaluate(({ ownPrefix, ownName }) => {
          const normIn = (s) => (s || '').replace(/\s+/g, ' ').trim()
          // Node comment = [role=article] có aria-label kiểu "Bình luận của X" / "Trả lời của X"
          const all = Array.from(document.querySelectorAll('[role="article"][aria-label]'))
            .filter(n => /omment|ình luận|rả lời|eply/i.test(n.getAttribute('aria-label') || ''))
          // aria-label là NGUỒN SỰ THẬT cho cả tên người viết lẫn quan hệ trả lời.
          //
          // Đo thật 26/08 (14 node trên một bài nhóm):
          //   "Tuấn Hoàng Dương 2 days ago"
          //   "Hoàng Mai Trang to Tuấn Hoàng Dương's comment 2 days ago"
          // Hai điều rút ra, cả hai đều làm hỏng bản cũ:
          //   1. Tên LUÔN dính hậu tố thời gian → so tên với username của nick
          //      không bao giờ khớp. Phải cắt đuôi thời gian trước khi so.
          //   2. Reply có depth = 0 — Facebook KHÔNG lồng DOM reply vào trong
          //      comment cha. Cách cũ gom reply bằng own.contains(x) vì thế luôn
          //      trả rỗng, kể cả khi thực sự có người trả lời. Quan hệ nằm ở
          //      cụm "to <tên>'s comment" trong label, không nằm ở cấu trúc DOM.
          const stripTime = (s) => (s || '')
            .replace(/\s+(vừa xong|just now|\d+\s*(giây|phút|giờ|ngày|tuần|tháng|năm|s|m|h|d|w|y|sec|min|hour|day|week|month|year)s?(\s*(trước|ago))?)$/i, '')
            .trim()
          const info = (n) => {
            const label = n.getAttribute('aria-label') || ''
            const lb = stripTime(normIn(label))
            // CHUỖI else-if, không phải nhiều if rời: các mẫu chồng lấn nhau nên
            // if rời làm mẫu sau ghi đè kết quả mẫu trước. Đo được khi tự test:
            // "Phản hồi bình luận của Lorena" khớp nhánh reply (đúng), rồi lại
            // khớp tiếp nhánh "bình luận của" → gán Lorena thành TÁC GIẢ, trong
            // khi Lorena là người ĐƯỢC trả lời. Ngược hẳn ý nghĩa.
            let author = null, replyTo = null, m = null
            if ((m = lb.match(/^(?:comment|reply)\s+by\s+(.+?)(?:\s+to\s+(.+?)(?:['’]s)?\s+comment)?$/i))) {
              author = m[1]; replyTo = m[2] || null                  // "Comment by X" | "Reply by X to Y's comment"
            } else if ((m = lb.match(/^(.+?)\s+to\s+(.+?)(?:['’]s)?\s+comment$/i))) {
              author = m[1]; replyTo = m[2]                          // "X to Y's comment"
            } else if ((m = lb.match(/^(?:phản hồi|trả lời)\s+bình luận của\s+(.+)$/i))) {
              replyTo = m[1]                                         // chỉ biết người ĐƯỢC trả lời
            } else if ((m = lb.match(/^bình luận của\s+(.+)$/i))) {
              author = m[1]
            } else if ((m = lb.match(/(?:của|by)\s+(.+?)$/i))) {
              author = m[1]
            } else if (lb) {
              // Dạng PHỔ BIẾN NHẤT lại suýt bị bỏ sót: label chỉ là tên trần
              // ("Tuấn Hoàng Dương 2 days ago" → sau khi cắt thời gian còn mỗi
              // tên). 3/4 mẫu thật thuộc dạng này; thiếu nhánh cuối là hỏng đúng
              // trường hợp hay gặp nhất.
              author = lb
            }

            let content = ''
            for (const d of n.querySelectorAll('div[dir="auto"]')) {
              const t = normIn(d.textContent)
              if (t.length > content.length) content = t
            }
            let cid = null
            const a = n.querySelector('a[href*="comment_id="]')
            if (a) { const mm = a.href.match(/comment_id=(\d+)/); if (mm) cid = mm[1] }
            return {
              label,
              author: author ? normIn(author) : null,
              replyTo: replyTo ? normIn(replyTo) : null,
              content: content.slice(0, 400), cid,
              depth: replyTo ? 1 : 0,
            }
          }
          const nodes = all.map(n => ({ n, ...info(n) }))
          // Comment CỦA NICK: khớp prefix nội dung (tin cậy nhất) hoặc author = tên nick
          const own = nodes.find(x => ownPrefix && x.content.includes(ownPrefix))
              || nodes.find(x => x.author && ownName && x.author.toLowerCase() === ownName.toLowerCase())
          if (!own) {
            // CHẨN ĐOÁN: 16/16 phiên trong 24h đều trượt ở đây (đo 25/08). Không
            // biết trượt vì DOM không có node comment nào, hay có mà so khớp sai,
            // thì mọi cách sửa đều là đoán. Trả về mẫu thật để phân biệt.
            // nodes=0 nghĩa là selector không thấy comment nào — thường gặp ở
            // trang xem ẢNH (/photo/?fbid=...), nơi Facebook dựng khung comment
            // bằng DOM khác. Thăm dò vài selector thay thế để lần sau sửa đúng
            // chỗ, thay vì thử từng selector một cách mù quáng.
            const probe = nodes.length ? null : {
              article_khong_label: document.querySelectorAll('[role="article"]').length,
              aria_binh_luan: document.querySelectorAll('[aria-label*="ình luận"], [aria-label*="omment"]').length,
              dialog: document.querySelectorAll('div[role="dialog"]').length,
              link_comment_id: document.querySelectorAll('a[href*="comment_id="]').length,
              la_trang_anh: /\/photo|fbid=/.test(location.href),
            }
            return {
              found: false,
              total: nodes.length,
              probe,
              samples: nodes.slice(0, 4).map(x => ({
                author: x.author, depth: x.depth, content: (x.content || '').slice(0, 50),
              })),
            }
          }
          // Reply CHO comment của nick = node có label "... to <tên nick>'s comment".
          // Không dùng own.n.contains() làm chính nữa: Facebook không lồng DOM
          // nên phép đó luôn rỗng (đo 26/08). Vẫn giữ contains làm đường phụ,
          // phòng khi giao diện khác có lồng thật.
          const tenNick = (ownName || '').toLowerCase()
          const laReplyChoNick = (x) => {
            if (x.n === own.n) return false
            if (x.replyTo && tenNick && x.replyTo.toLowerCase() === tenNick) return true
            return own.n.contains(x.n)
          }
          const nodeReplies = nodes.filter(laReplyChoNick)
          const replies = nodeReplies.map(({ n, ...rest }, i) => ({ ...rest, idx: i }))
          // Đánh dấu DOM để bấm "Trả lời" đúng chỗ sau này
          own.n.setAttribute('data-own-comment', '1')
          nodeReplies.forEach((x, i) => x.n.setAttribute('data-reply-idx', String(i)))
          return { found: true, ownAuthor: own.author, replies }
        }, { ownPrefix, ownName: account.username || '' })

        if (!thread.found) {
          stats.skipped.push(`own_comment_not_found:${target.fb_post_id}(nodes=${thread.total})`)
          if (stats.diag.length < 3) {
            stats.diag.push({
              url: (target.post_url || '').slice(0, 100),
              co_comment_id: String(target.post_url || '').includes('comment_id='),
              nodes: thread.total,
              tim: ownPrefix.slice(0, 40),
              thay: thread.samples || [],
              tham_do: thread.probe || null,
            })
          }
          continue
        }
        if (!thread.replies.length) continue   // chưa ai trả lời — bình thường

        stats.replies_found += thread.replies.length

        // ── Lọc reply đáng trả lời ──
        const candidateReplies = thread.replies.filter(r => {
          if (!r.content || r.content.length < 5) return false                       // "ok","haha"
          if (r.author && account.username && r.author.toLowerCase() === account.username.toLowerCase()) return false  // của chính mình
          if (!isVietnamese(r.content)) return false
          // Bản dịch tự động: nội dung đọc ra là tiếng Việt nhưng người viết
          // dùng ngoại ngữ — trả lời tiếng Việt là lạc quẻ (xem feed-dom.js).
          if (looksTranslated(r.content)) return false
          const nrm = stripDiacritics(r.content)
          if (SENSITIVE_PATTERNS.some(p => nrm.includes(p))) return false
          return true
        })

        // Dedup: đã trả lời reply nào rồi thì bỏ (ledger comment_logs)
        const ids = candidateReplies.map(r => r.cid).filter(Boolean)
        let repliedSet = new Set()
        if (ids.length) {
          const { data: done } = await supabase.from('comment_logs')
            .select('fb_post_id').eq('account_id', account_id)
            .eq('status', 'done').in('fb_post_id', ids)
          repliedSet = new Set((done || []).map(x => x.fb_post_id))
        }

        for (const rep of candidateReplies) {
          if (Date.now() > deadline) break
          if (tracker.get('reply') >= 3) break
          if (rep.cid && repliedSet.has(rep.cid)) continue
          const c2 = tracker.check('reply', replyBudget.used)
          if (!c2.allowed) break

          // Sinh trả lời — ngắn, persona voice (backend reply_gen)
          const gen = await hermes.generateReply({
            message: rep.content,
            context: `Bài gốc: "${norm(target.comment_text).slice(0, 120)}" — bạn đã comment và "${rep.author || 'một người'}" vừa trả lời bạn. Đáp lại ngắn gọn 1-2 câu, thân thiện, thuần tiếng Việt, đúng nội dung họ nói, không lặp lại, không markdown.`,
            language: 'vi',
            accountId: account_id,
          }).catch(() => null)
          const replyText = gen && (gen.text || gen)
          const cleanReply = typeof replyText === 'string' ? norm(replyText).slice(0, 300) : ''
          if (!cleanReply || cleanReply.length < 5) { stats.skipped.push('ai_empty'); continue }
          if (looksLikeMetaOutput(cleanReply)) { stats.skipped.push('ai_meta_output'); continue }

          if (dry_run) { stats.replied++; tracker.increment('reply'); continue }

          // ── Bấm "Trả lời" của đúng reply → gõ → Enter (fail-soft) ──
          const posted = await page.evaluate(async (idx) => {
            const node = document.querySelector(`[data-reply-idx="${idx}"]`) || document.querySelector('[data-own-comment="1"]')
            if (!node) return { ok: false, reason: 'node_gone' }
            const btn = Array.from(node.querySelectorAll('div[role="button"], a[role="link"], a'))
              .find(b => /^(trả lời|reply)$/i.test((b.textContent || '').trim()))
            if (!btn) return { ok: false, reason: 'no_reply_button' }
            btn.click()
            return { ok: true }
          }, rep.idx)
          if (!posted.ok) { stats.skipped.push(`dom:${posted.reason}`); continue }

          await R.sleepRange(1500, 3000)
          // Composer reply mở ra — gõ vào textbox đang focus (hoặc textbox cuối)
          const typed = await page.evaluate(() => {
            const boxes = Array.from(document.querySelectorAll('[contenteditable="true"][role="textbox"]'))
            const box = document.activeElement && document.activeElement.getAttribute('contenteditable') === 'true'
              ? document.activeElement : boxes[boxes.length - 1]
            if (!box) return false
            box.focus()
            return true
          })
          if (!typed) { stats.skipped.push('dom:no_composer'); continue }
          await page.keyboard.type(cleanReply, { delay: 40 + Math.floor(Math.random() * 60) })
          await R.sleepRange(800, 1500)
          await page.keyboard.press('Enter')
          await R.sleepRange(2500, 4500)

          stats.replied++
          tracker.increment('reply')

          // Ledger + vòng tự-học
          try {
            await supabase.from('comment_logs').insert({
              owner_id: account.owner_id,
              account_id,
              fb_post_id: rep.cid || `reply_${target.fb_post_id}_${Date.now()}`,
              post_url: target.post_url,
              source_name: 'reply',
              comment_text: cleanReply,
              status: 'done',
              ai_generated: true,
              finished_at: new Date().toISOString(),
            })
          } catch (e) { console.warn(`[CHECK-REPLIES] Ledger lỗi: ${e.message}`) }
          try {
            hermes.sendFeedback({
              taskType: 'reply_gen', outputText: cleanReply, score: 4,
              accountId: account_id, reason: 'reply_posted',
              context: { replied_to: (rep.content || '').slice(0, 100) },
            })
          } catch {}

          console.log(`[CHECK-REPLIES] ✅ Đã trả lời "${(rep.author || '?')}": ${cleanReply.slice(0, 60)}`)
          // Giãn cách giữa 2 reply — NHƯNG KHÔNG ngủ vượt deadline. Bản cũ ngủ
          // 60-120s vô điều kiện: vào vòng lúc ~7'50" rồi ngủ 2 phút là job
          // chạm mốc 10 phút và bị poller giết giữa chừng (đo thật 25/08).
          const conLai = deadline - Date.now()
          if (conLai > 90000) {
            await R.sleepRange(60000, Math.min(120000, conLai - 30000))
          } else {
            await R.sleepRange(3000, 6000)   // sắp hết giờ → nghỉ ngắn rồi thoát
          }
        }
      } catch (targetErr) {
        if (String(targetErr.message).startsWith('CIRCUIT_BREAKER')) throw targetErr
        stats.skipped.push(`target_err:${String(targetErr.message).slice(0, 60)}`)
      }
    }

    console.log(`[CHECK-REPLIES] Xong: kiểm ${stats.checked} comment, thấy ${stats.replies_found} reply, đã đáp ${stats.replied}${stats.skipped.length ? `, bỏ qua: ${stats.skipped.slice(0, 5).join('; ')}` : ''}`)
    return { success: true, ...stats, zero_action: stats.replied === 0 }
  } finally {
    await releaseSession(account_id, supabase)
  }
}

module.exports = checkReplies
