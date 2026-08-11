-- Feed (Newsfeed Farming) + Niche Profile + AI Usage — Migration
-- Run on VPS PostgreSQL (psql hoặc pg client) trước khi dùng tính năng. KHÔNG dùng Supabase.
-- Mô hình độc lập kiểu Scout: bảng riêng, KHÔNG đụng campaign_roles.

-- Setup auth schema if running on self-hosted PostgreSQL (idempotent, matches scout_migration.sql)
CREATE SCHEMA IF NOT EXISTS auth;
CREATE TABLE IF NOT EXISTS auth.users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid()
);
CREATE OR REPLACE FUNCTION auth.uid()
RETURNS UUID AS $$
  SELECT (current_setting('request.jwt.claims', true)::json->>'sub')::uuid;
$$ LANGUAGE SQL STABLE;

-- ═══════════════════════════════════════════════════════════════
-- 1. niche_profiles — 1 hồ sơ ngách cho mỗi nick
--    Đây là "profile chuyên về 1 mảng" trong yêu cầu. Per-account.
--    KHÔNG dùng ai_pilot_memory (có decay, tự xoá sau ~4 tuần).
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS niche_profiles (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  account_id        UUID NOT NULL,

  -- Định danh ngách
  niche             TEXT,                      -- vd "VPS/Hosting"
  persona           TEXT,                      -- giọng/tính cách nick
  tone              TEXT DEFAULT 'friendly',   -- friendly | expert | casual
  target_keywords   TEXT[] DEFAULT '{}',       -- từ khoá tương tác (AI mở rộng được)
  negative_keywords TEXT[] DEFAULT '{}',       -- từ khoá loại trừ (tuyển dụng, bán acc...)

  -- Công tắc
  professional_mode BOOLEAN DEFAULT FALSE,     -- đã bật Professional Mode trên FB chưa
  farming_enabled   BOOLEAN DEFAULT FALSE,     -- bật/tắt farm newsfeed
  posting_enabled   BOOLEAN DEFAULT FALSE,     -- bật/tắt tự đăng bài hàng ngày

  -- Hạn mức/ngày (ghi đè mặc định warm-up nếu set)
  daily_likes       INT DEFAULT 50,
  daily_comments    INT DEFAULT 8,
  daily_follows     INT DEFAULT 6,             -- gộp follow + add friend
  daily_group_joins INT DEFAULT 2,
  daily_posts       INT DEFAULT 1,

  -- Khoá cấu hình cho pilot 7 ngày (yêu cầu STEP 5)
  pilot_started_at  TIMESTAMPTZ,
  pilot_locked_until TIMESTAMPTZ,

  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(account_id)
);
ALTER TABLE niche_profiles ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "user_own_niche_profiles" ON niche_profiles;
CREATE POLICY "user_own_niche_profiles" ON niche_profiles USING (user_id = auth.uid());
CREATE INDEX IF NOT EXISTS idx_niche_profiles_user ON niche_profiles(user_id);

-- 1b. Cấu hình quảng cáo động — thêm sau, để riêng cho dễ đọc.
-- Đây là các cột UI tab "Nick" ghi vào; thiếu chúng thì nút Lưu sẽ lỗi.
ALTER TABLE niche_profiles ADD COLUMN IF NOT EXISTS ad_enabled BOOLEAN DEFAULT FALSE;
ALTER TABLE niche_profiles ADD COLUMN IF NOT EXISTS brand_name TEXT;
ALTER TABLE niche_profiles ADD COLUMN IF NOT EXISTS brand_description TEXT;
-- products: [{name, keywords[], description}] — LƯU Ý khoá là `description`,
-- vì lib/ai-brain.js và lib/ai-comment.js đọc `p.description` khi dựng prompt.
ALTER TABLE niche_profiles ADD COLUMN IF NOT EXISTS products JSONB DEFAULT '[]'::jsonb;
ALTER TABLE niche_profiles ADD COLUMN IF NOT EXISTS daily_ad_comments INT DEFAULT 2;
ALTER TABLE niche_profiles ADD COLUMN IF NOT EXISTS ad_min_score REAL DEFAULT 7;
ALTER TABLE niche_profiles ADD COLUMN IF NOT EXISTS ad_style TEXT DEFAULT 'soft';

-- 1c. Ngày tạo tài khoản Facebook THẬT — quyết định giai đoạn warm-up.
-- Thiếu cột này thì lib/hard-limits.js fallback sang accounts.created_at
-- (ngày thêm vào phần mềm) → nick Facebook lâu năm bị coi như nick mới tinh.
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS fb_created_at TIMESTAMPTZ;

-- ═══════════════════════════════════════════════════════════════
-- 2. feed_sessions — 1 phiên farm newsfeed (30-45 phút)
--    TÁCH RIÊNG khỏi comment_logs (đang mid-diagnosis) theo yêu cầu.
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS feed_sessions (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  account_id           UUID NOT NULL,
  job_id               UUID,
  session_kind         TEXT DEFAULT 'feed_scroll'
                         CHECK (session_kind IN ('feed_scroll','feed_seed','feed_expand')),

  started_at           TIMESTAMPTZ DEFAULT NOW(),
  finished_at          TIMESTAMPTZ,

  posts_scanned        INT DEFAULT 0,
  posts_liked          INT DEFAULT 0,
  posts_commented      INT DEFAULT 0,
  follows_sent         INT DEFAULT 0,
  friend_requests_sent INT DEFAULT 0,
  groups_joined        INT DEFAULT 0,

  status               TEXT DEFAULT 'running'
                         CHECK (status IN ('running','done','failed','aborted')),
  error_message        TEXT
);
ALTER TABLE feed_sessions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "user_own_feed_sessions" ON feed_sessions;
CREATE POLICY "user_own_feed_sessions" ON feed_sessions USING (user_id = auth.uid());
CREATE INDEX IF NOT EXISTS idx_feed_sessions_acc ON feed_sessions(user_id, account_id, started_at DESC);

-- ═══════════════════════════════════════════════════════════════
-- 3. feed_actions — từng hành động trong 1 phiên (log đầy đủ)
--    ai_moderator_verdict là JSONB: qualityGateComment trả object,
--    score có thể undefined ở nhánh too_short → TEXT sẽ mất dữ liệu.
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS feed_actions (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  session_id         UUID NOT NULL REFERENCES feed_sessions(id) ON DELETE CASCADE,
  account_id         UUID NOT NULL,

  action_type        TEXT NOT NULL
                       CHECK (action_type IN
                         ('scroll','dwell','like','comment','follow','add_friend','join_group','skip')),

  target_fb_post_id  TEXT,
  target_fb_user_id  TEXT,
  target_fb_group_id TEXT,
  post_url           TEXT,
  post_snippet       TEXT,                 -- trích nội dung bài (để audit)

  is_suggested       BOOLEAN DEFAULT FALSE, -- bài "Được đề xuất"/Trending?
  matched_keyword    TEXT,                  -- từ khoá nào khớp

  comment_text       TEXT,
  ai_moderator_verdict JSONB,              -- {approved, score, naturalness, relevance, value, reason}

  status             TEXT DEFAULT 'done'
                       CHECK (status IN ('done','failed','skipped')),
  skip_reason        TEXT,                  -- vd 'excluded_competitor', 'own_nick'
  error_message      TEXT,

  -- Hậu kiểm (job feed_verify điền sau 6h/24h) — nền cho vòng tự học
  verified_at        TIMESTAMPTZ,
  still_visible      BOOLEAN,
  likes_received     INT,
  replies_received   INT,

  created_at         TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE feed_actions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "user_own_feed_actions" ON feed_actions;
CREATE POLICY "user_own_feed_actions" ON feed_actions USING (user_id = auth.uid());
CREATE INDEX IF NOT EXISTS idx_feed_actions_session ON feed_actions(session_id);
CREATE INDEX IF NOT EXISTS idx_feed_actions_acc ON feed_actions(user_id, account_id, created_at DESC);
-- Chống comment trùng 1 bài
CREATE UNIQUE INDEX IF NOT EXISTS idx_feed_actions_dedup_comment
  ON feed_actions(account_id, target_fb_post_id)
  WHERE action_type = 'comment' AND target_fb_post_id IS NOT NULL;

-- 3b. Ghi lại quyết định quảng cáo trên từng comment (đo hiệu quả + audit)
ALTER TABLE feed_actions ADD COLUMN IF NOT EXISTS ad_strategy TEXT;
ALTER TABLE feed_actions ADD COLUMN IF NOT EXISTS matched_product TEXT;
ALTER TABLE feed_actions ADD COLUMN IF NOT EXISTS ad_score REAL;

-- ═══════════════════════════════════════════════════════════════
-- 4. feed_exclusions — luật loại trừ do user quản lý
--    (nick nhà được chặn TỰ ĐỘNG trong code, không cần nhập ở đây)
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS feed_exclusions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  exclude_type TEXT NOT NULL
                CHECK (exclude_type IN
                  ('competitor_page','competitor_keyword','blocked_user','blocked_topic')),
  value       TEXT NOT NULL,       -- fb_id hoặc từ khoá
  note        TEXT,
  is_active   BOOLEAN DEFAULT TRUE,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, exclude_type, value)
);
ALTER TABLE feed_exclusions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "user_own_feed_exclusions" ON feed_exclusions;
CREATE POLICY "user_own_feed_exclusions" ON feed_exclusions USING (user_id = auth.uid());
CREATE INDEX IF NOT EXISTS idx_feed_exclusions_user ON feed_exclusions(user_id, is_active);

-- ═══════════════════════════════════════════════════════════════
-- 5. feed_comment_exemplars — comment tốt dạy comment sau (few-shot động)
--    KHÔNG dùng ai_pilot_memory vì nó có decay tự xoá.
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS feed_comment_exemplars (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  account_id     UUID NOT NULL,
  niche          TEXT,
  post_snippet   TEXT,
  comment_text   TEXT NOT NULL,
  likes_received INT DEFAULT 0,
  replies_received INT DEFAULT 0,
  survived_days  INT DEFAULT 0,
  score          REAL DEFAULT 0,   -- điểm tổng hợp để xếp hạng few-shot
  created_at     TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE feed_comment_exemplars ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "user_own_feed_exemplars" ON feed_comment_exemplars;
CREATE POLICY "user_own_feed_exemplars" ON feed_comment_exemplars USING (user_id = auth.uid());
CREATE INDEX IF NOT EXISTS idx_feed_exemplars_rank
  ON feed_comment_exemplars(account_id, score DESC);

-- ═══════════════════════════════════════════════════════════════
-- 6. ai_usage_log — theo dõi token theo tác vụ + provider (chi phí)
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS ai_usage_log (
  id            BIGSERIAL PRIMARY KEY,
  user_id       UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  account_id    UUID,
  task_type     TEXT NOT NULL,
  provider      TEXT,
  model         TEXT,
  input_tokens  INT DEFAULT 0,
  output_tokens INT DEFAULT 0,
  latency_ms    INT,
  source        TEXT,             -- 'provider' | 'fallback' | 'error'
  ok            BOOLEAN DEFAULT TRUE,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE ai_usage_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "user_own_ai_usage" ON ai_usage_log;
CREATE POLICY "user_own_ai_usage" ON ai_usage_log USING (user_id = auth.uid());
CREATE INDEX IF NOT EXISTS idx_ai_usage_user_time ON ai_usage_log(user_id, created_at DESC);

-- ═══════════════════════════════════════════════════════════════
-- 7. Mở rộng jobs.type constraint cho 3 job type mới (nếu constraint còn tồn tại)
--    scratch/fix_jobs_constraint.sh đã từng DROP nó; chạy đoạn này an toàn dù có/không.
-- ═══════════════════════════════════════════════════════════════
ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_type_check;
-- Không add lại constraint: dự án theo pattern "drop thay vì mở rộng" (xem drop_hermes_constraint.sql).
-- Route job thuần theo registry in-memory (jobs/registry.js), không phụ thuộc DB constraint.
