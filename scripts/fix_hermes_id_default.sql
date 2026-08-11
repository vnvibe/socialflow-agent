-- Fix hermes_config id column default from constant 1 to a sequence nextval
CREATE SEQUENCE IF NOT EXISTS hermes_config_id_seq;

-- Set sequence next value to max ID + 1
SELECT setval('hermes_config_id_seq', COALESCE((SELECT MAX(id) FROM hermes_config), 1));

-- Alter column default
ALTER TABLE hermes_config ALTER COLUMN id SET DEFAULT nextval('hermes_config_id_seq');
