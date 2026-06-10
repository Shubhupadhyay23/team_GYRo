-- 012_queue_unique_index.sql
-- Add unique index for queue ON CONFLICT

CREATE UNIQUE INDEX IF NOT EXISTS idx_queue_active_user 
ON queue(user_id) WHERE status IN ('waiting', 'active');
