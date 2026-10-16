-- ===========================================================================
-- ScalpSphere — migration 002: customer portal
--
-- Adds the minimum needed for CUSTOMERS to authenticate against the same
-- `users` records the admin backend already manages. It deliberately does NOT
-- create a second user table, a second balance column, or any per-user
-- financial data that the product has not defined.
--
-- Design rules
--   * `users` remains the single source of truth for identity, profile and
--     the demo balance figure. `customer_auth` is a credential add-on keyed to
--     `users.id` (PRIMARY KEY + FK), so no user row is ever duplicated.
--   * No table here models money movement. This release is read-only.
--   * All constraints mirror the style of 001_schema.sql (InnoDB, utf8mb4,
--     CHECK constraints, timestamps, indexes on the lookup paths).
-- ===========================================================================

SET NAMES utf8mb4;
SET time_zone = '+00:00';

-- ---------------------------------------------------------------------------
-- Customer credentials. One row per `users` row that is allowed to sign in.
-- Mirrors `admins` for the fields that matter (bcrypt hash, lockout counters),
-- but is intentionally a separate table: administrators and customers are
-- different subjects with different lifecycles, and conflating them would let
-- an admin disable a customer's portal access or vice versa by accident.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS customer_auth (
  user_id             CHAR(36)     NOT NULL PRIMARY KEY,
  password_hash       VARCHAR(72)  NOT NULL,
  status              VARCHAR(20)  NOT NULL DEFAULT 'active',
  failed_login_count  SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  locked_until        DATETIME(3)  NULL,
  password_updated_at DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_login_at       DATETIME(3)  NULL,
  created_at          DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at          DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                    ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT chk_customer_auth_status CHECK (status IN ('active', 'disabled')),
  CONSTRAINT fk_customer_auth_user
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci;

-- ---------------------------------------------------------------------------
-- Customer refresh-token sessions. Same shape and same security properties as
-- `admin_sessions`: the token is opaque, random, and stored only as a SHA-256
-- hash, so a database disclosure does not leak usable sessions.
--
-- A separate table (rather than reusing admin_sessions) is required because
-- admin_sessions.user_id has a FOREIGN KEY to `admins`, and mixing subject
-- types into one table would weaken the referential guarantee that every
-- session belongs to exactly one kind of principal.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS customer_sessions (
  id                 CHAR(36)     NOT NULL PRIMARY KEY,
  user_id            CHAR(36)     NOT NULL,
  refresh_token_hash CHAR(64)     NOT NULL,
  issued_at          DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  expires_at         DATETIME(3)  NOT NULL,
  revoked_at         DATETIME(3)  NULL,
  revoked_reason     VARCHAR(60)  NULL,
  ip                 VARCHAR(45)  NULL,
  user_agent         VARCHAR(255) NULL,
  CONSTRAINT fk_customer_sessions_user
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  UNIQUE KEY uq_customer_sessions_refresh_hash (refresh_token_hash),
  KEY idx_customer_sessions_user (user_id, expires_at),
  KEY idx_customer_sessions_expires (expires_at)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci;
