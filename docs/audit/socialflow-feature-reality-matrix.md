# SocialFlow Feature Reality Matrix

Tài liệu này đánh giá tính xác thực (Reality) của các tính năng cốt lõi trong hệ thống **SocialFlow**, đối chiếu từ giao diện (Frontend) đến API Backend, Cơ sở dữ liệu (Database) và Playwright Agent.

---

## 1. Bản đồ Tính năng & Tính xác thực (Feature Mapping)

Hệ thống SocialFlow có mức độ hoàn thiện thực tế rất cao. Hầu hết các tính năng cốt lõi đều chạy **REAL** end-to-end dựa trên tương tác thật với Facebook qua Playwright và kết nối database PostgreSQL.

| Tính năng | Frontend Component | API Route | DB Table(s) | Agent / Scheduler Handler | Trạng thái | Minh chứng & Nhận xét |
| :--- | :--- | :--- | :--- | :--- | :---: | :--- |
| **Tạo Chiến dịch (Create campaign)** | [CampaignForm.jsx](file:///f:/Work/tools%20auto%20social/socialflow/frontend/src/pages/campaigns/CampaignForm.jsx) | `POST /campaigns` | `campaigns` | `campaign-planner.js` | **REAL** | UI gửi API lưu thông tin chiến dịch, mục tiêu, brand config, và ngân sách trực tiếp vào bảng `campaigns`. |
| **Gán Tài khoản/Nhóm (Assign account/group)** | [GroupsSection.jsx](file:///f:/Work/tools%20auto%20social/socialflow/frontend/src/pages/campaigns/sections/GroupsSection.jsx) | `POST /campaign-groups` | `campaign_groups`, `fb_groups` | N/A | **REAL** | Lưu mối quan hệ junction giữa tài khoản facebook (`accounts`) và nhóm (`fb_groups`) chỉ định trong chiến dịch. |
| **Nuôi dưỡng Chiến dịch (Campaign nurture)** | [Analytics.jsx](file:///f:/Work/tools%20auto%20social/socialflow/frontend/src/pages/analytics/Analytics.jsx) | `/agent-jobs/claim`, `/agent-jobs/report` | `jobs`, `comment_logs`, `nick_kpi_daily` | [campaign-nurture.js](file:///f:/Work/tools%20auto%20social/socialflow-agent/jobs/handlers/campaign-nurture.js) | **REAL** | Agent nhận job qua API, mở trình duyệt ảo, cuộn trang, like và viết bình luận thật lên Facebook thông qua Hermes AI, sau đó ghi nhận KPI. |
| **Tự động Tham gia Nhóm (Auto join group)** | N/A (Chạy ngầm) | N/A (Trigger bởi scheduler) | `jobs`, `campaign_groups` | [join-group.js](file:///f:/Work/tools%20auto%20social/socialflow-agent/jobs/handlers/join-group.js) | **REAL** | Scheduler quét nhóm chỉ định chưa join, tự động tạo job `join_group` và Agent dùng Playwright nhấn nút tham gia nhóm thật trên FB. |
| **Kiểm tra Sức khỏe (Check health)** | [CookieRepairModal.jsx](file:///f:/Work/tools%20auto%20social/socialflow/frontend/src/pages/hermes/CookieRepairModal.jsx) | `/agent-jobs/pending`, `/accounts/status` | `accounts`, `job_failures` | [check-health.js](file:///f:/Work/tools%20auto%20social/socialflow-agent/jobs/handlers/check-health.js) | **REAL** | Quét cookie của tài khoản, kiểm tra tình trạng checkpoint/restriction và cập nhật cột `status` trong bảng `accounts`. |
| **Đánh giá Nhóm & Tạo Bình luận bằng AI** | [HermesSettings.jsx](file:///f:/Work/tools%20auto%20social/socialflow/frontend/src/pages/hermes/HermesSettings.jsx) | `POST /ai-hermes/agent/comment`, `/relevance` | `hermes_calls` | `ai-filter.js` | **REAL** | Tích hợp trực tiếp với bộ não Hermes AI để phân tích ngữ cảnh bài viết và sinh ý kiến phản hồi theo Persona thiết lập. |
| **Cảnh báo Cookie Hết hạn (Cookie expired alert)** | [ProactiveAlerts.jsx](file:///f:/Work/tools%20auto%20social/socialflow/frontend/src/pages/layout/ProactiveAlerts.jsx) | N/A | `accounts` | [check-health.js](file:///f:/Work/tools%20auto%20social/socialflow-agent/jobs/handlers/check-health.js) | **PARTIAL** | Hệ thống cập nhật trạng thái `expired` của tài khoản trong DB và hiển thị dấu đỏ trên UI, nhưng chưa có cơ chế push alert/notification thời gian thực. |
| **Trạng thái Agent Online/Offline** | [DataCenterSection.jsx](file:///f:/Work/tools%20auto%20social/socialflow/frontend/src/pages/campaigns/sections/DataCenterSection.jsx) | `/agent-jobs/heartbeat` | `agent_heartbeats` | `agent.js` (heartbeat loop) | **REAL** | Agent gửi heartbeat định kỳ 30 giây để cập nhật RAM, số job đang chạy và ghi nhận trạng thái `online` vào DB. |
| **Dashboard Báo cáo KPI** | [Analytics.jsx](file:///f:/Work/tools%20auto%20social/socialflow/frontend/src/pages/analytics/Analytics.jsx) | `GET /analytics/kpi` | `nick_kpi_daily`, `comment_logs` | `kpi-calculator.js` | **REAL** | Đọc dữ liệu tương tác thực tế từ database và vẽ biểu đồ tiến độ thực hiện mục tiêu trong ngày. |

---

## 2. Minh chứng Chi tiết từ Mã nguồn (Codebase Evidence)

### A. Luồng Tạo Chiến dịch (Create Campaign)
- **Frontend:** File [CampaignForm.jsx](file:///f:/Work/tools%20auto%20social/socialflow/frontend/src/pages/campaigns/CampaignForm.jsx) thực hiện gọi `axios.post('/campaigns', payload)`.
- **API Backend:** File `socialflow/api/src/routes/campaigns.js` xử lý route `POST /` thực hiện kiểm tra quyền hạn và insert trực tiếp vào database:
  ```javascript
  const { data, error } = await req.supabase.from('campaigns').insert(newCampaign).select()
  ```
- **Database:** Dữ liệu lưu thẳng vào bảng `campaigns` bao gồm các trường cấu hình AI (`meta`, `brand_config`).

### B. Luồng Tương tác Nuôi dưỡng (Campaign Nurture)
- **Poller:** Agent chạy file [agent.js](file:///f:/Work/tools%20auto%20social/socialflow-agent/agent.js) kích hoạt poller quét job từ API.
- **Playwright Execution:** File [campaign-nurture.js](file:///f:/Work/tools%20auto%20social/socialflow-agent/jobs/handlers/campaign-nurture.js) ghé thăm group Facebook thật, cuộn trang, cào bài viết và gửi sang file `lib/ai-filter.js`.
- **AI Integration:** Thực hiện gọi API của bộ não Hermes qua `callAI({ taskType: 'relevance_score' })` để lấy điểm số liên quan của nhóm và bài viết.
- **Facebook Interaction:** Sử dụng Playwright tương tác thật (click nút thích, nhập bình luận).
- **KPI Logging:** Ghi nhận log bình luận thành công vào bảng `comment_logs` và tăng tiến độ `done_comments` trong bảng `nick_kpi_daily`.
- **Xác thực chạy thật:** Đã kiểm thử trực tiếp và ghi nhận bình luận của nick Việt Nguyễn thành công lên Facebook nhóm OpenClaw VN lúc 22:14 ngày 04/06/2026. Dữ liệu KPI đã cập nhật thực tế trong DB.
