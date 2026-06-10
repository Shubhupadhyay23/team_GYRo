-- 011_add_password_hash.sql
-- Add password_hash column to users table

ALTER TABLE users ADD COLUMN password_hash text;
