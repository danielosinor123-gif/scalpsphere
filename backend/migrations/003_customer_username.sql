-- ===========================================================================
-- ScalpSphere — migration 003: customer usernames
--
-- The live product's registration form (stakeclone.com/register) requires a
-- `username` field in addition to `name` and `email`. This adds the column to
-- the shared `users` table so the form-compatible registration endpoint can
-- store it. Unique, NULL-able so existing rows are unaffected.
-- ===========================================================================

SET NAMES utf8mb4;
SET time_zone = '+00:00';

ALTER TABLE users
  ADD COLUMN username VARCHAR(60) NULL
    AFTER email;

ALTER TABLE users
  ADD UNIQUE KEY uq_users_username (username);
