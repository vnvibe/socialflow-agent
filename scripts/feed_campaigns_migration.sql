-- ═══════════════════════════════════════════════════════════════
-- feed_campaigns — "camp newsfeed": nhóm agent theo CHỦ ĐỀ thay vì
-- cấu hình từng nick lẻ. Kéo agent vào camp = đồng bộ cấu hình camp
-- xuống niche_profiles của nick đó (handler phía agent chỉ đọc
-- niche_profiles nên KHÔNG cần đổi code agent / rebuild exe).
--
-- mode:
--   'nurture'      — chỉ tương tác nuôi nick (like/dwell/comment tự nhiên)
--   'nurture_ads'  — nuôi + chèn quảng cáo khi phát hiện bài liên quan
--
-- Idempotent: chạy lại nhiều lần an toàn.
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS feed_campaigns (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  name              TEXT NOT NULL,
  topic             TEXT,                      -- chủ đề xyz, đổ xuống niche_profiles.niche
  tone              TEXT DEFAULT 'friendly',
  persona           TEXT,
  target_keywords   TEXT[] DEFAULT '{}',
  negative_keywords TEXT[] DEFAULT '{}',

  mode              TEXT DEFAULT 'nurture'
                      CHECK (mode IN ('nurture','nurture_ads')),
  brand_name        TEXT,
  brand_description TEXT,
  products          JSONB DEFAULT '[]'::jsonb,
  daily_ad_comments INT DEFAULT 2,

  -- Hạn mức/ngày mặc định cho mọi nick trong camp
  daily_likes       INT DEFAULT 50,
  daily_comments    INT DEFAULT 8,
  daily_follows     INT DEFAULT 6,
  daily_group_joins INT DEFAULT 2,
  daily_posts       INT DEFAULT 1,

  -- Số phiên farm / ngày mà feed-scheduler sẽ đẻ job
  sessions_per_day  INT DEFAULT 2,
  seed_per_day      INT DEFAULT 1,

  enabled           BOOLEAN DEFAULT TRUE,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE feed_campaigns ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "user_own_feed_campaigns" ON feed_campaigns;
CREATE POLICY "user_own_feed_campaigns" ON feed_campaigns USING (user_id = auth.uid());
CREATE INDEX IF NOT EXISTS idx_feed_campaigns_user ON feed_campaigns(user_id);

-- Nick thuộc camp nào (NULL = chưa vào camp; cấu hình lẻ kiểu cũ vẫn hợp lệ)
ALTER TABLE niche_profiles ADD COLUMN IF NOT EXISTS feed_campaign_id UUID;
CREATE INDEX IF NOT EXISTS idx_niche_profiles_camp ON niche_profiles(feed_campaign_id);

-- 09/08/2026: chế độ giả lập. TRUE = agent cuộn feed, chấm điểm, sinh comment
-- nhưng KHÔNG like/không đăng — mọi hành động ghi log với skip_reason='dry_run'.
-- Camp mới mặc định BẬT giả lập để user xem nick định làm gì trước khi cho chạy thật.
ALTER TABLE feed_campaigns ADD COLUMN IF NOT EXISTS dry_run BOOLEAN DEFAULT TRUE;
