-- Scout (Do Thám) — Migration
-- Run this on VPS PostgreSQL (psql hoặc pg client) before using the feature

-- Setup auth schema if running on self-hosted PostgreSQL
CREATE SCHEMA IF NOT EXISTS auth;
CREATE TABLE IF NOT EXISTS auth.users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid()
);
CREATE OR REPLACE FUNCTION auth.uid()
RETURNS UUID AS $$
  SELECT (current_setting('request.jwt.claims', true)::json->>'sub')::uuid;
$$ LANGUAGE SQL STABLE;

-- 1. scout_targets — groups to monitor
CREATE TABLE IF NOT EXISTS scout_targets (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name          TEXT,
  fb_group_id   TEXT NOT NULL,
  fb_group_url  TEXT,
  is_active     BOOLEAN DEFAULT TRUE,
  scan_interval_hours INT DEFAULT 6,
  last_scanned_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE scout_targets ENABLE ROW LEVEL SECURITY;
CREATE POLICY "user_own_scout_targets" ON scout_targets USING (user_id = auth.uid());
CREATE UNIQUE INDEX IF NOT EXISTS idx_scout_targets_user_group ON scout_targets(user_id, fb_group_id);

-- 2. scout_posts — scraped posts
CREATE TABLE IF NOT EXISTS scout_posts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  scout_target_id UUID NOT NULL REFERENCES scout_targets(id) ON DELETE CASCADE,
  fb_group_id     TEXT NOT NULL,
  post_fb_id      TEXT NOT NULL,
  post_url        TEXT NOT NULL,
  author_name     TEXT,
  author_fb_id    TEXT,
  content         TEXT,
  post_type       TEXT,
  reaction_count  INT,
  comment_count   INT,
  scanned_comments_count INT DEFAULT 0,
  posted_at       TIMESTAMPTZ,
  scanned_at      TIMESTAMPTZ DEFAULT NOW(),
  scanned_by_account_id UUID,
  UNIQUE(user_id, post_fb_id)
);
ALTER TABLE scout_posts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "user_own_scout_posts" ON scout_posts USING (user_id = auth.uid());
CREATE INDEX IF NOT EXISTS idx_scout_posts_target ON scout_posts(user_id, scout_target_id, scanned_at DESC);
CREATE INDEX IF NOT EXISTS idx_scout_posts_dedup ON scout_posts(user_id, post_fb_id);

-- 3. scout_comments — comments per post
CREATE TABLE IF NOT EXISTS scout_comments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  scout_post_id   UUID NOT NULL REFERENCES scout_posts(id) ON DELETE CASCADE,
  post_fb_id      TEXT NOT NULL,
  comment_fb_id   TEXT,
  author_name     TEXT,
  author_fb_id    TEXT,
  content         TEXT NOT NULL,
  reaction_count  INT DEFAULT 0,
  is_reply        BOOLEAN DEFAULT FALSE,
  parent_comment_fb_id TEXT,
  commented_at    TIMESTAMPTZ,
  scanned_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, comment_fb_id)
);
ALTER TABLE scout_comments ENABLE ROW LEVEL SECURITY;
CREATE POLICY "user_own_scout_comments" ON scout_comments USING (user_id = auth.uid());
CREATE INDEX IF NOT EXISTS idx_scout_comments_post ON scout_comments(scout_post_id);

-- 4. scout_job_logs — scan job history
CREATE TABLE IF NOT EXISTS scout_job_logs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  scout_target_id UUID REFERENCES scout_targets(id),
  account_id      UUID,
  job_id          UUID,
  posts_found     INT DEFAULT 0,
  posts_new       INT DEFAULT 0,
  posts_skipped   INT DEFAULT 0,
  comments_collected INT DEFAULT 0,
  status          TEXT,
  error_message   TEXT,
  started_at      TIMESTAMPTZ,
  finished_at     TIMESTAMPTZ
);
ALTER TABLE scout_job_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "user_own_scout_job_logs" ON scout_job_logs USING (user_id = auth.uid());
