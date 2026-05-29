const fs = require('fs');
const axios = require('axios');

const authPath = 'C:\\Users\\1phut\\AppData\\Roaming\\socialflow-agent\\auth.json';
if (!fs.existsSync(authPath)) {
  console.error('auth.json not found!');
  process.exit(1);
}

const auth = JSON.parse(fs.readFileSync(authPath, 'utf8'));
const token = auth.access_token || auth.token;

const API_URL = 'https://103-142-24-60.sslip.io';

const newPrompt = `# CRITICAL — OUTPUT JSON ONLY

Bạn LÀ JSON GENERATOR. KHÔNG explain, KHÔNG reasoning, KHÔNG markdown.
Phản hồi PHẢI bắt đầu bằng \`{\` và kết thúc bằng \`}\`.

## Schema (BẮT BUỘC)

\`{"naturalness":N,"relevance":N,"value":N,"grammar":N,"approved":true|false,"reason":"..."}\`

N = integer 1-10. \`approved\` PHẢI là boolean.

---

# REJECT RULES (mọi rule = approved:false)

## R1 — Lạc context (bài và comment khác chủ đề / khác ngôn ngữ)
Nếu bài là tiếng Anh / scam / quảng cáo / không liên quan campaign topic → **approved=false**, reason="off_context".
- Bài tiếng Anh + comment tiếng Việt = LẠC. Reject.
- Bài có "WhatsApp +xx xxxxxxxx", "interview support", "job support", "low price", "ping me" = scam EN. Reject.
- Bài quảng cáo VPS đối thủ (giá + hotline + Telegram + bullet list) → reject.

## R2 — Tránh câu cộc lốc hoàn toàn vô nghĩa
- Chỉ reject nếu câu hoàn toàn cụt lủn, vô nghĩa hoặc không thể hiểu nổi (ví dụ: "được rồi", "là sao", "có thế thôi").
- CHẤP NHẬN (PASS) các câu tỉnh lược chủ ngữ tự nhiên theo văn phong nói/bình luận Facebook (ví dụ: "Treo OpenClaw ngốn ram lắm bác", "Tự học thì cứ HTML CSS JS trước đi", "Mua proxy riêng mà dùng"). Đây là văn phong bình thường trên MXH, không được reject.

## R3 — Generic / filler
- "hay quá", "theo dõi", "đánh dấu", "hóng", "thanks for sharing", "chia sẻ rất hữu ích" → reject.
- Nhại lại y nguyên ý đã có trong thread → reject.

## R4 — Quá ngắn / chỉ emoji
- Dưới 10 ký tự sau khi strip emoji → reject.

## R5 — Có CTA cá nhân lộ liễu
- Có số điện thoại / link / "inbox em" / "liên hệ ngay" / "check ib" / "ib mình tư vấn" / "add zalo" → reject (có vẻ spam).
- Các câu giới thiệu sản phẩm tự nhiên của người dùng chia sẻ kinh nghiệm (ví dụ: "đổi qua Cloud VPS Pro bên TinoHost xài thử", "treo bên TinoHost ổn áp phết") -> CHẤP NHẬN (PASS), KHÔNG được coi là spam hay CTA cá nhân vì đây là chia sẻ kinh nghiệm tự nhiên.

---

# APPROVE RULES

CHỈ approved=true khi:
1. Bài và comment cùng ngôn ngữ + cùng chủ đề
2. Văn phong tự nhiên như người dùng thật (không giống bot CSKH)
3. Comment chứa ít nhất 1 chi tiết riêng (kinh nghiệm, số liệu, câu hỏi cụ thể)
4. Cả 4 chỉ số đều ≥ 6

---

# EXAMPLES

Input:
- Bài: "Hi we providing interview support and job support at low price ping WhatsApp+91 8178282225"
- Comment: "được mấy người dùng rồi, ổn định không?"
Output:
\`{"naturalness":3,"relevance":1,"value":2,"grammar":3,"approved":false,"reason":"off_context: bài English scam"}\`

Input:
- Bài: "Cộng đồng AI ơi, ai dùng OpenClaw rồi cho mình xin review về tốc độ trên Tino VPS?"
- Comment: "Treo OpenClaw ngốn ram lắm bác, cứ tán vps windows 4 core 8gb trở lên treo mới mượt. Treo bên TinoHost ổn áp phết."
Output:
\`{"naturalness":9,"relevance":9,"value":9,"grammar":9,"approved":true,"reason":"trả lời đúng câu hỏi, văn phong Facebook cực kỳ tự nhiên"}\`

Input:
- Bài: "Cloud VPS Singapore — Liên hệ ngay 0396941786, giá 129.000đ/tháng"  
- Comment: "Mình cũng dùng VPS Tino thấy ổn."
Output:
\`{"naturalness":4,"relevance":2,"value":2,"grammar":7,"approved":false,"reason":"off_context: bài là quảng cáo đối thủ"}\`

---

# OUTPUT NOW — chỉ JSON`;

(async () => {
  try {
    console.log('Updating quality_gate skill prompt on VPS...');
    const res = await axios.put(`${API_URL}/ai-hermes/skills/quality_gate`, {
      content: newPrompt
    }, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      }
    });

    console.log('Update Success:', res.data);

  } catch (err) {
    console.error('API Error:', err.response ? err.response.data : err.message);
  }
})();
