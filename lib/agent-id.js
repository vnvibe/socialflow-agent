/**
 * Định danh máy — NGUỒN DUY NHẤT cho toàn bộ agent.
 *
 * Trước đây mỗi nơi tự tính một kiểu, và cả hai kiểu đều sai:
 *
 *   agent.js  : config.AGENT_ID = "audit-agent" (nướng sẵn lúc build)
 *               → MỌI máy cài agent đều mang cùng một tên. Hai máy cùng chạy
 *                 sẽ ghi đè chung một dòng heartbeat, tranh job của cùng nick,
 *                 và tệ nhất là cùng mở trình duyệt trên một nick từ hai IP
 *                 → Facebook bắt checkpoint. Sự cố 10/08 đúng kiểu này.
 *
 *   poller.js : `${hostname}-${pid}`
 *               → đổi tên sau MỖI lần khởi động. Hệ quả: (a) bảng
 *                 agent_heartbeats phình 40+ dòng rác (VIETNGUYEN-147552,
 *                 -221068, …); (b) câu cứu job kẹt lúc khởi động lọc
 *                 `.eq('agent_id', AGENT_ID)` KHÔNG BAO GIỜ khớp job của lần
 *                 chạy trước (pid đã khác) → job kẹt không ai cứu.
 *
 *   Ngoài ra hai nơi tính ra hai giá trị KHÁC NHAU, nên heartbeat khai một
 *   tên còn job lại nhận dưới tên khác — khoá tài khoản phía server vì thế
 *   không thể tin vào agent_id.
 *
 * Cách đúng: sinh mã máy ngẫu nhiên ĐÚNG MỘT LẦN, ghi ra đĩa, các lần sau đọc
 * lại. Vừa ổn định qua khởi động lại, vừa khác nhau giữa các máy.
 */

const os = require('os')
const fs = require('fs')
const path = require('path')

let _cached = null

function getAgentId() {
  if (_cached) return _cached
  // Cho phép đặt tên chủ động khi triển khai nhiều máy.
  if (process.env.AGENT_ID) {
    _cached = process.env.AGENT_ID
    return _cached
  }

  const idFile = path.join(os.homedir(), '.socialflow-machine-id')
  let machineId = null
  try {
    if (fs.existsSync(idFile)) {
      machineId = fs.readFileSync(idFile, 'utf8').trim() || null
    }
    if (!machineId) {
      machineId = require('crypto').randomBytes(4).toString('hex')
      fs.writeFileSync(idFile, machineId, 'utf8')
      console.log(`[AGENT] Sinh mã máy mới: ${machineId} (lưu tại ${idFile})`)
    }
  } catch (err) {
    // Không ghi được đĩa (thiếu quyền, ổ chỉ đọc…) → vẫn phải chạy được.
    // Dùng tên máy: kém lý tưởng nếu hai máy trùng tên, nhưng vẫn hơn hẳn
    // việc mọi máy dùng chung một hằng số.
    console.warn(`[AGENT] Không lưu được mã máy (${err.message}) — dùng tên máy thay thế`)
    _cached = `${os.hostname()}-fallback`
    return _cached
  }
  _cached = `${os.hostname()}-${machineId}`
  return _cached
}

module.exports = { getAgentId }
