/**
 * watchdog.js — Đảm bảo SocialFlow Agent LUÔN chạy (SaaS 24/7).
 *
 * Electron main.js đã tự restart AGENT-con (tối đa 10 lần) + chặn máy ngủ.
 * Watchdog này vá 3 lỗ hổng còn lại mà main.js không lo được:
 *   1. App Electron bị tắt/crash hẳn  → khởi động lại app.
 *   2. Máy reboot                      → (scheduled task) mở lại app.
 *   3. Agent TREO (alive nhưng không xử job) hoặc đã bỏ cuộc sau 10 restart
 *      → kill + mở lại app tươi (reset bộ đếm).
 *
 * Chạy định kỳ bằng Windows Task Scheduler (mỗi 5 phút). An toàn: chỉ restart
 * khi (a) không thấy process, hoặc (b) TREO rõ ràng — không xử job nào trong
 * STALL_MIN phút DÙ có job đến hạn. Không có job đến hạn thì đứng im là bình
 * thường (đêm/rảnh) → KHÔNG restart oan.
 */
const path = require('path')
const fs = require('fs')
const { execSync, spawn } = require('child_process')
try { require('dotenv').config({ path: path.join(__dirname, '..', '.env') }) } catch {}

const EXE = 'F:\\Work\\tools auto social\\socialflow-agent\\dist\\win-unpacked\\SocialFlow Agent.exe'
const PROC = 'SocialFlow Agent.exe'
// 60 (không phải 30): poller nghỉ per-nick 20-45 phút (nickRestUntil, chống
// checkpoint). Khi mọi nick cùng nghỉ, agent đứng im hợp lệ tới ~45 phút. Ngưỡng
// 30 cũ kill nhầm giữa kỳ nghỉ + restart xoá nickRestUntil in-memory → nick
// hành động sớm hơn an toàn. 60 nằm trên trần nghỉ 45 + biên; process-alive vẫn
// check mỗi 5 phút nên crash bắt nhanh, chỉ ca "poller treo mà process sống"
// mới chờ tới 60 phút (hiếm).
const STALL_MIN = 60
const LOG = path.join(__dirname, '..', 'watchdog.log')

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`
  console.log(line)
  try { fs.appendFileSync(LOG, line + '\n') } catch {}
  // xoay log nếu >2MB
  try { if (fs.statSync(LOG).size > 2 * 1024 * 1024) fs.writeFileSync(LOG, line + '\n') } catch {}
}

function isRunning() {
  try {
    const out = execSync(`tasklist /FI "IMAGENAME eq ${PROC}" /NH`, { encoding: 'utf8', windowsHide: true })
    return out.includes(PROC)
  } catch { return false }
}
function startAgent() {
  if (!fs.existsSync(EXE)) { log(`LỖI: không thấy exe tại ${EXE}`); return false }
  const p = spawn(EXE, [], { detached: true, stdio: 'ignore', windowsHide: false })
  p.unref()
  log('→ Đã khởi động SocialFlow Agent')
  return true
}
function killAgent() {
  try { execSync(`taskkill /F /IM "${PROC}"`, { stdio: 'ignore', windowsHide: true }) } catch {}
}

async function checkStall() {
  const url = process.env.DATABASE_URL
  if (!url) return { ok: true, reason: 'no_db_url' }   // không có DB thì bỏ qua kiểm treo
  let Client
  try { ({ Client } = require('pg')) } catch { return { ok: true, reason: 'no_pg' } }
  const c = new Client({ connectionString: url, ssl: false })
  await c.connect()
  try {
    // MỐC HOẠT ĐỘNG = job xong gần nhất HOẶC job bắt đầu gần nhất. Trước đây chỉ
    // nhìn finished_at → agent đang chạy job DÀI (campaign_nurture/feed_seed có
    // thể >30 phút) bị coi là TREO và bị kill GIỮA CHỪNG (nghi là 1 nguyên nhân
    // feed_seed timeout/cancel). Nay: đang có job claimed/running, hoặc vừa
    // start job trong STALL_MIN → agent RÕ RÀNG còn sống, KHÔNG kill.
    const last = await c.query(`SELECT max(finished_at) m FROM jobs WHERE finished_at > now() - interval '3 hours'`)
    const lastStart = await c.query(`SELECT max(started_at) m FROM jobs WHERE started_at > now() - interval '3 hours'`)
    const running = await c.query(`SELECT count(*)::int n FROM jobs WHERE status IN ('claimed','running')`)
    const due = await c.query(`SELECT count(*)::int n FROM jobs WHERE status='pending' AND scheduled_at <= now()`)
    const finMs = last.rows[0].m ? (Date.now() - new Date(last.rows[0].m).getTime()) : Infinity
    const startMs = lastStart.rows[0].m ? (Date.now() - new Date(lastStart.rows[0].m).getTime()) : Infinity
    const actMs = Math.min(finMs, startMs)   // hoạt động gần nhất (xong HOẶC bắt đầu)
    const lastMin = actMs === Infinity ? Infinity : Math.round(actMs / 60000)
    const dueN = due.rows[0].n
    const runningN = running.rows[0].n
    // TREO thật = không xong/không bắt đầu job nào trong STALL_MIN, KHÔNG có job
    // đang chạy, MÀ vẫn có job đến hạn.
    const stall = lastMin > STALL_MIN && dueN > 0 && runningN === 0
    return { ok: !stall, lastMin, due: dueN, running: runningN }
  } finally { await c.end() }
}

;(async () => {
  if (!isRunning()) {
    log('Agent KHÔNG chạy (app tắt/crash/reboot) → khởi động lại')
    startAgent()
    return
  }
  try {
    const s = await checkStall()
    if (!s.ok && s.due !== undefined) {
      log(`Agent TREO: job xong gần nhất ${s.lastMin === Infinity ? '>3h' : s.lastMin + ' phút'} trước, ${s.due} job đến hạn chờ → kill + mở lại`)
      killAgent()
      await new Promise(r => setTimeout(r, 5000))
      startAgent()
    } else {
      log(`OK — agent chạy${s.lastMin !== undefined ? `, hoạt động gần nhất ${s.lastMin === Infinity ? '>3h' : s.lastMin + ' phút'}, ${s.running || 0} đang chạy, ${s.due || 0} job chờ` : ''}`)
    }
  } catch (e) {
    log(`Không kiểm treo được (${e.message}) — agent vẫn chạy, bỏ qua`)
  }
})()
