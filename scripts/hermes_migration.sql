-- Migration to support per-user hermes_config
-- Setup auth schema if running on self-hosted PostgreSQL
CREATE SCHEMA IF NOT EXISTS auth;
CREATE TABLE IF NOT EXISTS auth.users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid()
);

-- Add user_id column if not exists
ALTER TABLE hermes_config ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;

-- Add unique constraint on user_id so each user has exactly one config row
ALTER TABLE hermes_config DROP CONSTRAINT IF EXISTS uq_hermes_config_user_id;
ALTER TABLE hermes_config ADD CONSTRAINT uq_hermes_config_user_id UNIQUE (user_id);

-- Enable RLS on hermes_config
ALTER TABLE hermes_config ENABLE ROW LEVEL SECURITY;

-- Policy for reading: own config OR system default (id = 1)
DROP POLICY IF EXISTS "user_read_hermes_config" ON hermes_config;
CREATE POLICY "user_read_hermes_config" ON hermes_config 
  FOR SELECT 
  USING (user_id = auth.uid() OR id = 1);

-- Policy for write operations (insert, update, delete): only own config
DROP POLICY IF EXISTS "user_write_hermes_config" ON hermes_config;
CREATE POLICY "user_write_hermes_config" ON hermes_config 
  FOR ALL 
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());
