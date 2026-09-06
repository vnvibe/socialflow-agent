/**
 * file-logger.js — Đổ mọi thứ agent in ra console vào MỘT FILE trên đĩa.
 *
 * VÌ SAO CẦN:
 * Trước 27/08 log runtime của agent KHÔNG hề chạm đĩa. Vỏ Electron gom stdout
 * của tiến trình con vào một mảng trong RAM giới hạn 500 dòng (electron/main.js
 * `addLog`), đẩy lên cửa sổ rồi thôi. Hệ quả đo thật: agent chết lúc 22:49 ngày
 * 27/08, watchdog dựng lại sau 1 phút, và toàn bộ output giải thích VÌ SAO chết
 * bay sạch — không cách nào truy. Đóng cửa sổ Electron cũng mất. Mỗi lần restart
 * lại reset. Đó là lý do mọi yêu cầu "xem log" đều không ra gì.
 *
 * VÌ SAO ĐẶT Ở AGENT CHỨ KHÔNG Ở ELECTRON:
 * electron/main.js nằm trong app.asar nén → sửa nó bắt buộc `npm run build`, mà
 * build lại đòi xoá dist/win-unpacked — thư mục ĐANG BỊ chính app chạy khoá
 * (ERR_ELECTRON_BUILDER_CANNOT_EXECUTE, d3dcompiler_47.dll: Access is denied).
 * Đặt ở agent thì hot-reload được (~4s), và log vẫn có cả khi chạy agent trần
 * không qua Electron.
 *
 * Xoay vòng ở 10MB, giữ 1 bản .1. Mọi lỗi ghi file đều NUỐT: log hỏng thì thôi,
 * tuyệt đối không được làm chết agent chỉ vì không ghi được log.
 */
const fs = require('fs')
const path = require('path')

const MAX_BYTES = 10 * 1024 * 1024
let _daCanhBao = false
let _duongDan = null

function xoayVongNeuDay(file) {
  try {
    if (fs.statSync(file).size > MAX_BYTES) fs.renameSync(file, file + '.1')
  } catch {}   // chưa có file → statSync ném; kệ, appendFileSync sẽ tạo
}

function ghi(file, muc, phan) {
  try {
    const dong = phan.map(x => {
      if (typeof x === 'string') return x
      try { return require('util').inspect(x, { depth: 2, breakLength: 200 }) } catch { return String(x) }
    }).join(' ')
    xoayVongNeuDay(file)
    fs.appendFileSync(file, `${new Date().toISOString()} [${muc}] ${dong}\n`)
  } catch (e) {
    if (!_daCanhBao) {
      _daCanhBao = true
      process.stderr.write(`[FILE-LOGGER] không ghi được log: ${e.message}\n`)
    }
  }
}

/**
 * Bọc console.log/warn/error để vừa in ra stdout (vỏ Electron vẫn hiển thị
 * như cũ) vừa nối vào file. Gọi MỘT LẦN, sớm nhất có thể trong agent.js.
 * Gọi lại lần nữa là no-op — tránh bọc chồng nhau sau hot-reload.
 */
function batDauGhiFile(thuMucGoc) {
  if (console.__daBocFileLogger) return _duongDan
  // thuMucGoc = thư mục gốc agent (agent.js truyền __dirname của chính nó).
  // Mặc định lùi 1 cấp từ lib/ cho trường hợp gọi mà không truyền gì.
  const goc = thuMucGoc || path.resolve(__dirname, '..')
  const file = path.join(goc, 'agent-runtime.log')
  _duongDan = file

  for (const [ten, muc] of [['log', 'info'], ['warn', 'warn'], ['error', 'error']]) {
    const goc = console[ten].bind(console)
    console[ten] = (...phan) => { goc(...phan); ghi(file, muc, phan) }
  }
  console.__daBocFileLogger = true

  // Lỗi không ai bắt = nguyên nhân chết phổ biến nhất. agent.js gọi
  // process.exit ở handler nên nếu không ghi ngay tại đây thì mất luôn.
  process.on('uncaughtException', (e) => ghi(file, 'fatal', ['uncaughtException:', e && e.stack || e]))
  process.on('unhandledRejection', (e) => ghi(file, 'fatal', ['unhandledRejection:', e && e.stack || e]))
  process.on('exit', (ma) => ghi(file, 'info', [`--- agent thoát, mã ${ma} ---`]))

  return file
}

module.exports = { batDauGhiFile }
