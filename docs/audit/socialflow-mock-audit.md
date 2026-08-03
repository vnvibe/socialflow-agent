# SocialFlow Mock/Fake Audit Report

Báo cáo này liệt kê và phân tích các trường hợp xuất hiện từ khóa liên quan đến "mock", "fake", hoặc "hardcoded" trong toàn bộ cơ sở mã nguồn Frontend, API Backend, và Desktop Agent.

---

## 1. Kết quả Scan Tổng quan

Hệ thống **không sử dụng mock** ở tầng Database hay xử lý nghiệp vụ chính của Agent. Hầu hết các phát hiện từ khóa tập trung vào:
- Các chuỗi `placeholder` trong UI Input (ví dụ: mô tả nhập liệu gợi ý cho người dùng).
- Các cơ chế lưu trữ tạm thời qua `localStorage`/`sessionStorage` của trình duyệt ở Frontend để giữ trạng thái giao diện và token xác thực đăng nhập.
- Không tìm thấy cơ chế mock dữ liệu (msw, mirage, json-server) trong môi trường Production của API hay Agent.

---

## 2. Danh sách Chi tiết các phát hiện từ khóa (Keyword Hits)

Dưới đây là một số phát hiện tiêu biểu đã qua phân loại mức độ rủi ro:

| File | Line | Từ khóa | Nội dung dòng Code | Phân loại & Rủi ro |
| :--- | :---: | :--- | :--- | :--- |
| [comment-post.js](file:///f:/Work/tools%20auto%20social/socialflow-agent/jobs/handlers/comment-post.js#L125-L126) | 125-126 | `placeholder` | `'textarea[placeholder*="bình luận" i]'` | **REAL (Selector):** Selector của Playwright để tìm ô nhập bình luận trên Facebook UI. Rủi ro: Không. |
| [campaigns.js](file:///f:/Work/tools%20auto%20social/socialflow/api/src/routes/campaigns.js#L233) | 233 | `placeholder` | `name: "Group " + fbGroupId, // placeholder name` | **REAL (Fallback):** Đặt tên tạm thời cho nhóm nếu không cào được tên nhóm ngay lập tức. Rủi ro: Thấp. |
| [api.js](file:///f:/Work/tools%20auto%20social/socialflow/frontend/src/lib/api.js#L14) | 14 | `localStorage` | `const token = localStorage.getItem('sf_token')` | **REAL (Session):** Đọc JWT token để xác thực API của Frontend. Rủi ro: Không. |
| [ProactiveAlerts.jsx](file:///f:/Work/tools%20auto%20social/socialflow/frontend/src/components/layout/ProactiveAlerts.jsx#L46) | 46 | `localStorage` | `JSON.parse(localStorage.getItem('proactive-alerts-seen') || '[]')` | **REAL (UI State):** Lưu các cảnh báo đã xem để tránh lặp lại. Rủi ro: Không. |
| [AccountList.jsx](file:///f:/Work/tools%20auto%20social/socialflow/frontend/src/pages/accounts/AccountList.jsx#L697) | 697 | `placeholder` | `placeholder="Paste cookie here..."` | **REAL (UI Guide):** Chuỗi hướng dẫn dán cookie. Rủi ro: Không. |
| [Analytics.jsx](file:///f:/Work/tools%20auto%20social/socialflow/frontend/src/pages/analytics/Analytics.jsx#L62) | 62 | `placeholder` | `{/* Chart placeholder */}` | **REAL (UI Draft):** Placeholder vẽ chart khi chưa load xong dữ liệu. Rủi ro: Thấp. |
| [UnifiedPublish.jsx](file:///f:/Work/tools%20auto%20social/socialflow/frontend/src/pages/publish/UnifiedPublish.jsx#L176) | 176 | `sessionStorage` | `const prefill = sessionStorage.getItem('publish_prefill')` | **REAL (UI Flow):** Chuyển tiếp dữ liệu bài đăng viết sẵn giữa các trang. Rủi ro: Không. |

---

## 3. Nhận xét & Đánh giá Rủi ro
- **Frontend Dashboard:** Các chỉ số KPI, danh sách tài khoản, và nhật ký hoạt động đều được lấy trực tiếp từ API (`GET /analytics/kpi` và `GET /accounts`), không dùng số liệu giả lập (Fake Stats).
- **Hermes AI responses:** Tích hợp gọi API thật tới FastAPI Hermes. Trong trường hợp lỗi kết nối, hệ thống ghi nhận lỗi job và dừng xử lý, không tự động sinh phản hồi giả (Mock AI response) để báo thành công ảo.
- **Production Safety:** Không phát hiện bất kỳ cờ `VITE_USE_MOCK` hay `ALLOW_MOCKS` nào được kích hoạt ở môi trường Production.
