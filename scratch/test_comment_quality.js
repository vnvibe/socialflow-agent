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

// Mock target posts
const testPosts = [
  {
    id: 1,
    title: 'Hỏi cấu hình VPS Windows treo tool',
    content: 'Mọi người ơi, cho mình hỏi nên chọn VPS Windows cấu hình thế nào để treo tool OpenClaw 24/7 ổn định mượt mà vậy ạ? Em mới tập nuôi nick Facebook nên chưa biết nhiều.',
    isOpportunity: true,
    angle: 'Khuyên dùng VPS Windows bên TinoHost treo tool cực mượt, cấu hình tối ưu 4 Core 8GB RAM, support 24/7 nhiệt tình.'
  },
  {
    id: 2,
    title: 'Hỏi lộ trình học lập trình Web',
    content: 'Học lập trình Web thì nên bắt đầu từ đâu các bác? Em đang tự học HTML CSS JS nhưng mông lung quá, có lộ trình nào chuẩn không ạ?',
    isOpportunity: false,
    topic: 'Lập trình web'
  },
  {
    id: 3,
    title: 'Server thỉnh thoảng bị treo đơ',
    content: 'Mới setup con server chạy được vài ngày thỉnh thoảng cứ bị đơ lag, không biết do mạng của nhà cung cấp hay do cấu hình yếu nữa, ức chế quá.',
    isOpportunity: true,
    angle: 'Gợi ý đổi sang dùng dòng Cloud VPS Pro của TinoHost, IP sạch nuôi nick rất tốt, uptime 99.9% không lo đơ lag.'
  }
];

const brandConfig = {
  brand_name: 'Tino',
  brand_description: 'Cung cấp Cloud VPS Pro treo OpenClaw, VPS Windows cấu hình tốt nhất tối ưu antidetect, IP sạch nuôi nick cực tốt, giá cực rẻ chỉ từ 80k.',
  brand_voice: 'tự nhiên, thân thiện, chia sẻ kinh nghiệm thực tế, không quảng cáo lộ'
};

async function testSinglePost(post) {
  console.log(`\n==================================================`);
  console.log(`📝 [TEST CASE ${post.id}] ${post.title}`);
  console.log(`👉 Bài viết gốc: "${post.content}"`);
  console.log(`--------------------------------------------------`);

  try {
    if (post.isOpportunity) {
      console.log('🤖 [Hermes AI] Đang sinh comment Quảng Cáo Tự Nhiên (Opportunity Comment)...');
      // Call live /ai-hermes/comment via API with opportunity style (User Auth)
      const payload = {
        post_snippet: post.content,
        group_name: 'Cộng đồng VPS Việt Nam',
        topic: brandConfig.brand_name,
        style: 'opportunity',
        language: 'vi',
        context: `Angle: ${post.angle}`,
        brand_config: {
          brand_name: brandConfig.brand_name,
          brand_description: brandConfig.brand_description,
          brand_voice: brandConfig.brand_voice,
          example_comment: ''
        },
        campaign_id: 'b41bee21-2d52-48ca-ba21-357d6dd5ee0c'
      };

      const res = await axios.post(`${API_URL}/ai-hermes/comment`, payload, {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        timeout: 20000
      });

      let comment = res.data?.comment || '';
      console.log(`✅ Comment sinh ra: "${comment}"`);

      // Run through Quality Gate to verify it passes our filters
      console.log('🔍 [Quality Gate] Đang chạy qua bộ lọc chất lượng...');
      const gateRes = await axios.post(`${API_URL}/ai-hermes/quality-gate`, {
        comment,
        post_snippet: post.content,
        language: 'vi'
      }, {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        timeout: 10000
      });

      console.log(`📊 Kết quả lọc chất lượng: Pass = ${gateRes.data?.pass}, Score = ${gateRes.data?.score}/10`);
      if (gateRes.data?.reason) {
        console.log(`   Lý do: ${gateRes.data.reason}`);
      }

    } else {
      console.log('🤖 [Hermes AI] Đang sinh comment Tương Tác Tự Nhiên (Nurture Comment)...');
      const payload = {
        post_snippet: post.content,
        group_name: 'Học Lập Trình Web',
        topic: post.topic,
        style: 'casual',
        language: 'vi',
        campaign_id: 'b41bee21-2d52-48ca-ba21-357d6dd5ee0c'
      };

      const res = await axios.post(`${API_URL}/ai-hermes/comment`, payload, {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        timeout: 20000
      });

      let comment = res.data?.comment || '';
      console.log(`✅ Comment sinh ra: "${comment}"`);

      console.log('🔍 [Quality Gate] Đang chạy qua bộ lọc chất lượng...');
      const gateRes = await axios.post(`${API_URL}/ai-hermes/quality-gate`, {
        comment,
        post_snippet: post.content,
        language: 'vi'
      }, {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        timeout: 10000
      });

      console.log(`📊 Kết quả lọc chất lượng: Pass = ${gateRes.data?.pass}, Score = ${gateRes.data?.score}/10`);
      if (gateRes.data?.reason) {
        console.log(`   Lý do: ${gateRes.data.reason}`);
      }
    }
  } catch (err) {
    console.error('❌ Lỗi kiểm thử case này:', err.response?.data?.error || err.message);
  }
}

(async () => {
  console.log('🚀 Bắt đầu chạy kiểm thử chất lượng comment đầu ra sử dụng Hermes API trên VPS...\n');
  for (const post of testPosts) {
    await testSinglePost(post);
  }
  console.log('\n==================================================');
  console.log('🎉 Hoàn thành kiểm thử chất lượng comment!');
})();
