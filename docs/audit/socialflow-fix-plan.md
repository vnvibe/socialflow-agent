# Kế hoạch Khắc phục & Tối ưu hóa Hệ thống SocialFlow

Tài liệu này vạch ra kế hoạch sửa lỗi và cải tiến kiến trúc hệ thống **SocialFlow** để giải quyết các rủi ro về hiệu năng tương tác và độ ổn định của hệ thống.

---

## 1. Các Ưu tiên thực hiện (Implementation Priorities)

### 🔴 Ưu tiên P0: Khắc phục sự cố kết nối DNS sslip.io
- **Mục tiêu:** Đảm bảo Agent luôn kết nối được với VPS ngay cả khi DNS cục bộ lỗi.
- **Giải pháp:** Cấu hình biến môi trường hoặc file config của Agent để hỗ trợ cơ chế dự phòng:
  ```json
  {
    "api_url": "https://103.142.24.60",
    "headers": { "Host": "103-142-24-60.sslip.io" },
    "servername": "103-142-24-60.sslip.io"
  }
  ```
  Tích hợp logic này vào client Axios và WebSocket kết nối của Agent.

### 🔴 Ưu tiên P1: Xây dựng dịch vụ điều phối bài viết (Post Reservation Service)
- **Mục tiêu:** Giải quyết triệt để tình trạng nghẽn KPI (0 comment) khi nhiều nick chạy chung nhóm chỉ định.
- **Giải pháp:** 
  1. Tạo bảng `post_interaction_reservations` trong database:
     ```sql
     CREATE TABLE post_interaction_reservations (
       id BIGSERIAL PRIMARY KEY,
       campaign_id UUID NOT NULL,
       group_id TEXT NOT NULL,
       post_id TEXT NOT NULL,
       account_id UUID NOT NULL,
       status TEXT NOT NULL DEFAULT 'reserved', -- 'reserved', 'completed'
       reserved_until TIMESTAMPTZ NOT NULL,
       created_at TIMESTAMPTZ DEFAULT now()
     );
     ```
  2. Xây dựng API `POST /campaigns/:id/reserve-post` nhận danh sách `post_ids` từ Agent và trả về bài viết duy nhất được cấp quyền tương tác (được lock trong 15 phút).
  3. Cập nhật [campaign-nurture.js](file:///f:/Work/tools%20auto%20social/socialflow-agent/jobs/handlers/campaign-nurture.js) để gọi API này sau khi quét bài viết thay vì tự lọc trùng lặp cục bộ.

### 🟡 Ưu tiên P2: Chuyển kiểm soát Rate Limit ghé thăm nhóm về Scheduler
- **Mục tiêu:** Tránh việc tạo ra các job nurture vô ích khi nhóm đã hết công suất ghé thăm.
- **Giải pháp:**
  1. Tạo bảng `group_visit_leases` để theo dõi lượt ghé thăm nhóm:
     ```sql
     CREATE TABLE group_visit_leases (
       id BIGSERIAL PRIMARY KEY,
       group_id TEXT NOT NULL,
       account_id UUID NOT NULL,
       slot_start TIMESTAMPTZ NOT NULL,
       slot_end TIMESTAMPTZ NOT NULL
     );
     ```
  2. Trước khi tạo job nurture trong `campaign-scheduler.js`, thực hiện kiểm tra số lượt ghé thăm nhóm trong vòng 30 phút qua. Chỉ tạo job khi còn slot trống.

### 🟡 Ưu tiên P3: Tự động cảnh báo Cookie hết hạn (Account Alerts)
- **Mục tiêu:** Giúp quản trị viên phát hiện ngay tài khoản bị lỗi đăng nhập.
- **Giải pháp:**
  1. Tạo bảng `account_alerts` để lưu trữ các cảnh báo sức khỏe tài khoản.
  2. Cập nhật [check-health.js](file:///f:/Work/tools%20auto%20social/socialflow-agent/jobs/handlers/check-health.js): khi phát hiện cookie hết hạn hoặc checkpoint, tự động ghi nhận alert mới và gửi webhook cảnh báo qua Telegram/Slack của chiến dịch.
  3. Hiển thị thông báo dạng Pop-up hoặc badge đếm lỗi nổi bật trên Web Dashboard.

### 🟢 Ưu tiên P4: Khóa phân tán cho Scheduler (Scheduler Lock)
- **Mục tiêu:** Ngăn chặn chạy trùng cron khi nâng cấp hệ thống chạy đa nhân bản (multi-replica).
- **Giải pháp:** Sử dụng PostgreSQL Advisory Lock (`SELECT pg_try_advisory_lock(1001)`) ở đầu tick cron trong `campaign-scheduler.js`. Chỉ chạy tạo job nếu giành được lock thành công.
