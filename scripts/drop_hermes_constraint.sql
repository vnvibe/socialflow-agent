-- Drop check constraint that restricts table to a single row with id = 1
ALTER TABLE hermes_config DROP CONSTRAINT IF EXISTS hermes_config_id_check;
