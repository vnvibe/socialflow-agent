#!/usr/bin/env node
/**
 * import_cookie.js — Nạp cookie Facebook (dạng JSON export) vào accounts.cookie_string.
 *
 * BẢO MẬT: script đọc cookie từ FILE bạn tự lưu, ghi thẳng vào DB.
 *   Giá trị cookie KHÔNG bao giờ được in ra màn hình/log — chỉ in fb_user_id
 *   và xác nhận đã che (masked). Sau khi import xong nên xoá file JSON.
 *
 * Dùng:
 *   node scripts/import_cookie.js <path-to-cookies.json> [owner_id] [username]
 *
 * cookies.json: mảng [{name, value, domain, ...}] (định dạng export của extension).
 * owner_id: bắt buộc khi tạo nick mới (mặc định lấy env AGENT_USER_ID).
 */

const fs = require('fs')
const { db } = require('../lib/db')

const REQUIRED = ['c_user', 'xs']
const KNOWN = ['c_user', 'xs', 'datr', 'fr', 'sb', 'ps_l', 'ps_n', 'presence', 'wd']

function mask(v) {
  if (!v) return '(rỗng)'
  if (v.length <= 6) return '***'
  return v.slice(0, 3) + '...' + v.slice(-3)
}

async function main() {
  const filePath = process.argv[2]
  const ownerId = process.argv[3] || process.env.AGENT_USER_ID
  const usernameArg = process.argv[4]

  if (!filePath) {
    console.error('Thiếu đường dẫn file. Dùng: node scripts/import_cookie.js <cookies.json> [owner_id] [username]')
    process.exit(1)
  }
  if (!fs.existsSync(filePath)) {
    console.error(`Không tìm thấy file: ${filePath}`)
    process.exit(1)
  }

  let arr
  try {
    arr = JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch (e) {
    console.error(`File không phải JSON hợp lệ: ${e.message}`)
    process.exit(1)
  }
  if (!Array.isArray(arr)) {
    console.error('JSON phải là MẢNG các cookie [{name, value, ...}]')
    process.exit(1)
  }

  // Dựng cookie_string + trích c_user
  const byName = {}
  for (const c of arr) {
    if (c && c.name && c.value != null) byName[c.name] = String(c.value)
  }
  const missing = REQUIRED.filter(n => !byName[n])
  if (missing.length) {
    console.error(`Thiếu cookie bắt buộc: ${missing.join(', ')} — không import.`)
    process.exit(1)
  }

  const cookieString = Object.entries(byName).map(([k, v]) => `${k}=${v}`).join('; ')
  const fbUserId = byName['c_user']

  // In xác nhận — CHE giá trị
  console.log('Cookie đọc được (đã che):')
  for (const n of KNOWN) {
    if (byName[n] != null) console.log(`  ${n.padEnd(9)} = ${mask(byName[n])}`)
  }
  const extra = Object.keys(byName).filter(n => !KNOWN.includes(n))
  if (extra.length) console.log(`  (+${extra.length} cookie khác)`)
  console.log(`  → fb_user_id = ${fbUserId}`)

  // Tìm nick sẵn có theo fb_user_id
  const { data: existing, error: selErr } = await db
    .from('accounts').select('id, username, owner_id').eq('fb_user_id', fbUserId).limit(1)
  if (selErr) { console.error(`Lỗi truy vấn: ${selErr.message || selErr}`); process.exit(1) }

  if (existing && existing.length) {
    const acc = existing[0]
    const { error: upErr } = await db.from('accounts').update({
      cookie_string: cookieString,
      status: 'healthy',
      is_active: true,
    }).eq('id', acc.id)
    if (upErr) { console.error(`Lỗi cập nhật: ${upErr.message || upErr}`); process.exit(1) }
    console.log(`\n✅ Đã CẬP NHẬT cookie cho nick sẵn có: ${acc.username || acc.id} (${acc.id})`)
  } else {
    if (!ownerId) {
      console.error('\nNick chưa tồn tại và thiếu owner_id. Truyền owner_id (arg 2) hoặc set env AGENT_USER_ID.')
      process.exit(1)
    }
    const { data: ins, error: insErr } = await db.from('accounts').insert({
      owner_id: ownerId,
      platform: 'facebook',
      fb_user_id: fbUserId,
      username: usernameArg || `fb_${fbUserId}`,
      cookie_string: cookieString,
      status: 'healthy',
      is_active: true,
    }).select('id')
    if (insErr) { console.error(`Lỗi tạo nick: ${insErr.message || insErr}`); process.exit(1) }
    console.log(`\n✅ Đã TẠO nick mới: ${ins?.[0]?.id || '(id?)'} — owner ${ownerId}`)
  }

  console.log('\n⚠️  Nên XOÁ file cookie JSON sau khi import xong.')
  process.exit(0)
}

main().catch(e => { console.error('Lỗi:', e.message); process.exit(1) })
