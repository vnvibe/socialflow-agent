# SocialFlow System Stability & Risks Report

Tài liệu này phân tích các rủi ro hệ thống ảnh hưởng đến tính ổn định và tính chính xác của chiến dịch tương tác mạng xã hội trong dự án **SocialFlow**.

---

## 1. Đánh giá các Rủi ro Ổn định (Stability Risks)

### Rủi ro 1: Trùng lặp bình luận (Duplicate Comment Filter) gây nghẽn KPI
- **Đánh giá mức độ:** 🔴 **HIGH RISK**
- **Chi tiết:** Để tránh các nick trong cùng một chiến dịch bình luận trùng vào một bài viết, agent tự động lọc bỏ các bài viết đã có bình luận của chiến dịch đó. Khi chạy chung một tập nhóm chỉ định nhỏ (ví dụ: chiến dịch Tino chạy duy nhất 1 nhóm), các nick bắt đầu sau trong hàng đợi sẽ không còn bài viết hợp lệ để bình luận. Kết quả là tiến độ KPI Comments của họ luôn bằng 0.
- **Nguyên nhân:** Thiếu dịch vụ điều phối đặt trước bài viết (Central Post Reservation Service) ở API Backend. Mỗi agent tự kéo bài viết và lọc cục bộ ở client.

### Rủi ro 2: Giới hạn tần suất ghé thăm nhóm (Group Visit Rate Limit)
- **Đánh giá mức độ:** 🔴 **HIGH RISK**
- **Chi tiết:** Hệ thống cấu hình giới hạn tối đa 2 nicks ghé thăm cùng 1 nhóm trong vòng 30 phút. Khi scheduler tạo dồn dập nhiều job nurture cho các nick khác nhau tại cùng một nhóm chỉ định, nick chạy sau sẽ lập tức skip nhóm vì chạm rate limit. Job hoàn thành nhanh nhưng hụt KPI.
- **Nguyên nhân:** Kiểm tra rate limit được thực hiện ở client (Agent) lúc bắt đầu chạy job thay vì được kiểm soát từ khâu tạo/phân bổ job của Scheduler.

### Rủi ro 3: Phân giải tên miền sslip.io trên VPS
- **Đánh giá mức độ:** 🟡 **MEDIUM RISK**
- **Chi tiết:** Node.js chạy trên môi trường VPS đôi khi bị lỗi phân giải DNS đối với tên miền động `103-142-24-60.sslip.io` (lỗi `getaddrinfo ENOTFOUND`), dẫn đến ngắt kết nối WebSocket bridge và hỏng luồng chạy CLI hoặc API.
- **Giải pháp hiện tại:** Đã được sửa thủ công ở các script kiểm tra bằng cách sử dụng địa chỉ IP trực tiếp `103.142.24.60` kết hợp tham số TLS `servername` và `Host` header. Tuy nhiên, mã nguồn chính của API và Agent cần được tích hợp cấu hình dự phòng (DNS fallback) này để tự động xử lý khi có sự cố.

### Rủi ro 4: Tranh chấp nhận Job (Atomic Job Claim)
- **Đánh giá mức độ:** 🟢 **LOW RISK**
- **Chi tiết:** Kiểm tra mã nguồn API endpoint `PATCH /agent-jobs/:id/claim` trong file `socialflow/api/src/routes/agent-jobs.js` cho thấy cơ chế nhận job đã được thiết kế an toàn:
  ```javascript
  const { data, error } = await supabase
    .from('jobs')
    .update({ status: 'claimed', ... })
    .eq('id', req.params.id)
    .eq('status', 'pending')
  ```
  Câu lệnh `UPDATE` này thực hiện cập nhật có điều kiện trạng thái `status = 'pending'`. Trong PostgreSQL, điều này đảm bảo tính nguyên tử (atomic). Khi nhiều agent cùng tranh chấp một job, chỉ có một agent thực hiện update thành công (trả về row count = 1), agent còn lại sẽ nhận về kết quả rỗng và API trả về `409 Conflict`.

### Rủi ro 5: Xung đột kích hoạt Scheduler (Scheduler Lock)
- **Đánh giá mức độ:** 🟡 **MEDIUM RISK**
- **Chi tiết:** Hiện tại cron scheduler đang được chạy trực tiếp cùng API server thông qua `node-cron`. Nếu API Backend được nhân bản chạy tải cân bằng (load balancing/multiple replicas), cron sẽ bị kích hoạt đồng thời trên nhiều instance, gây ra việc tạo trùng job.
- **Giải pháp đề xuất:** Cần đưa cơ chế khóa phân tán (Distributed Lock hoặc PG advisory lock) vào trước khi chạy tick scheduler trong `campaign-scheduler.js`.
