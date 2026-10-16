-- ===========================================================================
-- ScalpSphere admin backend — schema migration 001
--
-- Scope: ONLY the tables required by the API surface implemented here.
-- Deliberately excluded: deposits, investments, trading, staking, KYC
-- documents, email, leads, tasks, copy-trading, bots, and any payment-provider
-- integration. Those admin sections are generic placeholders in the supplied
-- HTML and are out of scope by design.
--
-- Conventions
--   * InnoDB + utf8mb4 everywhere.
--   * Opaque CHAR(36) UUID primary keys (no guessable/auto-increment IDs).
--   * All money is stored as INTEGER MINOR UNITS (cents), never FLOAT/DOUBLE.
--   * Every mutable table carries created_at / updated_at.
--   * Enum-like columns use VARCHAR + CHECK constraints so invalid states are
--     rejected by the database, not only by the application.
-- ===========================================================================

SET NAMES utf8mb4;
SET time_zone = '+00:00';

-- ---------------------------------------------------------------------------
-- Migration bookkeeping (populated by scripts/migrate.js)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS schema_migrations (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  filename      VARCHAR(190) NOT NULL,
  checksum      CHAR(64)     NOT NULL,
  applied_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_schema_migrations_filename (filename)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci;

-- ---------------------------------------------------------------------------
-- Short human-friendly public references (SS-USR-00001, ...).
--
-- All prefixes share one AUTO_INCREMENT column, so one statement both reserves
-- and returns the next number:
--
--   INSERT INTO ref_sequences (entity_prefix) VALUES (?)
--     ON DUPLICATE KEY UPDATE seq = LAST_INSERT_ID(seq + 1);
--   SELECT LAST_INSERT_ID();
--
-- A fresh insert takes the next auto value; an existing row takes seq + 1.
-- Either way LAST_INSERT_ID() returns the allocated number, so there is no
-- read-then-write pair to race.
--
-- `seq` is indexed with a NON-UNIQUE key on purpose: a UNIQUE key would make the
-- bump collide with whatever row already owns that number, because every prefix
-- increments the same column. An AUTO_INCREMENT column still has to be a key,
-- and a plain index satisfies that.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ref_sequences (
  entity_prefix CHAR(3)         NOT NULL,
  seq           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  PRIMARY KEY (entity_prefix),
  KEY idx_ref_sequences_seq (seq)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci;

-- ---------------------------------------------------------------------------
-- Administrators. The ONLY authentication subject in this API.
-- There is deliberately no public registration and no seeded default admin:
-- the first administrator is provisioned out-of-band by
-- `npm run admin:create` (see docs/SECURITY.md).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS admins (
  id                  CHAR(36)     NOT NULL PRIMARY KEY,
  email               VARCHAR(254) NOT NULL,
  password_hash       VARCHAR(72)  NOT NULL,
  full_name           VARCHAR(120) NOT NULL,
  role                VARCHAR(20)  NOT NULL DEFAULT 'admin',
  status              VARCHAR(20)  NOT NULL DEFAULT 'active',
  failed_login_count  SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  locked_until        DATETIME(3)  NULL,
  last_login_at       DATETIME(3)  NULL,
  password_updated_at DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  created_at          DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at          DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                    ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT chk_admins_role   CHECK (role   IN ('owner', 'admin', 'support')),
  CONSTRAINT chk_admins_status CHECK (status IN ('active', 'disabled')),
  UNIQUE KEY uq_admins_email (email)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci;

-- ---------------------------------------------------------------------------
-- Server-side refresh-token sessions (revocable, rotated, hash-only).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS admin_sessions (
  id                 CHAR(36)     NOT NULL PRIMARY KEY,
  admin_id           CHAR(36)     NOT NULL,
  refresh_token_hash CHAR(64)     NOT NULL,
  issued_at          DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  expires_at         DATETIME(3)  NOT NULL,
  revoked_at         DATETIME(3)  NULL,
  revoked_reason     VARCHAR(60)  NULL,
  ip                 VARCHAR(45)  NULL,
  user_agent         VARCHAR(255) NULL,
  CONSTRAINT fk_admin_sessions_admin
    FOREIGN KEY (admin_id) REFERENCES admins (id) ON DELETE CASCADE,
  UNIQUE KEY uq_admin_sessions_refresh_hash (refresh_token_hash),
  KEY idx_admin_sessions_admin (admin_id, expires_at),
  KEY idx_admin_sessions_expires (expires_at)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci;

-- ---------------------------------------------------------------------------
-- Platform users shown in "Manage Users".
-- `is_demo` marks every row created by the synthetic seed command.
-- No authentication credentials belong to this table — it is admin CRM data,
-- not a login store.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id           CHAR(36)     NOT NULL PRIMARY KEY,
  public_ref   VARCHAR(20)  NOT NULL,
  full_name    VARCHAR(120) NOT NULL,
  email        VARCHAR(254) NOT NULL,
  balance_minor BIGINT      NOT NULL DEFAULT 0,
  currency     CHAR(3)      NOT NULL DEFAULT 'USD',
  status       VARCHAR(20)  NOT NULL DEFAULT 'active',
  kyc_status   VARCHAR(20)  NOT NULL DEFAULT 'pending',
  is_demo      TINYINT(1)   NOT NULL DEFAULT 0,
  created_at   DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at   DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                             ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT chk_users_status     CHECK (status     IN ('active', 'inactive')),
  CONSTRAINT chk_users_kyc_status CHECK (kyc_status IN ('pending', 'verified', 'rejected')),
  CONSTRAINT chk_users_balance    CHECK (balance_minor >= 0),
  CONSTRAINT chk_users_demo       CHECK (is_demo IN (0, 1)),
  UNIQUE KEY uq_users_email (email),
  UNIQUE KEY uq_users_public_ref (public_ref),
  KEY idx_users_created_at (created_at),
  KEY idx_users_status_created (status, created_at),
  FULLTEXT KEY ft_users_search (full_name, email)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci;

-- ---------------------------------------------------------------------------
-- Withdrawal requests shown in "Manage clients withdrawals".
-- This is a review/queue table only: the API never moves money, never calls a
-- payment provider, and never contacts a user about a request.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS withdrawals (
  id             CHAR(36)     NOT NULL PRIMARY KEY,
  public_ref     VARCHAR(20)  NOT NULL,
  user_id        CHAR(36)     NOT NULL,
  amount_minor   BIGINT       NOT NULL,
  fee_minor      BIGINT       NOT NULL DEFAULT 0,
  method         VARCHAR(80)  NOT NULL,
  receiver_email VARCHAR(254) NOT NULL,
  status         VARCHAR(20)  NOT NULL DEFAULT 'pending',
  is_demo        TINYINT(1)   NOT NULL DEFAULT 0,
  created_at     DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at     DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                               ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT chk_withdrawals_status CHECK (status IN ('pending', 'processed', 'failed', 'cancelled')),
  CONSTRAINT chk_withdrawals_amount CHECK (amount_minor > 0),
  CONSTRAINT chk_withdrawals_fee    CHECK (fee_minor >= 0),
  CONSTRAINT chk_withdrawals_demo   CHECK (is_demo IN (0, 1)),
  CONSTRAINT fk_withdrawals_user FOREIGN KEY (user_id) REFERENCES users (id),
  UNIQUE KEY uq_withdrawals_public_ref (public_ref),
  KEY idx_withdrawals_status_created (status, created_at),
  KEY idx_withdrawals_created (created_at),
  KEY idx_withdrawals_user (user_id),
  FULLTEXT KEY ft_withdrawals_search (method, receiver_email)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci;

-- ---------------------------------------------------------------------------
-- Payment methods ("Payment Settings" → "Payment Methods" tab).
-- `used_for` mirrors the vocabulary used by the supplied HTML: deposit /
-- withdraw / both. Delete is a hard delete; enable/disable is a status flip.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payment_methods (
  id         CHAR(36)     NOT NULL PRIMARY KEY,
  public_ref VARCHAR(20)  NOT NULL,
  name       VARCHAR(80)  NOT NULL,
  type       VARCHAR(20)  NOT NULL,
  used_for   VARCHAR(20)  NOT NULL,
  status     VARCHAR(20)  NOT NULL DEFAULT 'disabled',
  is_demo    TINYINT(1)   NOT NULL DEFAULT 0,
  created_at DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                           ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT chk_payment_methods_type   CHECK (type     IN ('crypto', 'currency')),
  CONSTRAINT chk_payment_methods_used   CHECK (used_for IN ('deposit', 'withdraw', 'both')),
  CONSTRAINT chk_payment_methods_status CHECK (status   IN ('enabled', 'disabled')),
  CONSTRAINT chk_payment_methods_demo   CHECK (is_demo IN (0, 1)),
  UNIQUE KEY uq_payment_methods_name (name),
  UNIQUE KEY uq_payment_methods_ref (public_ref),
  KEY idx_payment_methods_status (status)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci;

-- ---------------------------------------------------------------------------
-- Payment preferences ("Payment Settings" → "Payment Preference" form).
-- Exactly one row, enforced by `id = 1` plus a CHECK constraint.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payment_settings (
  id                     TINYINT UNSIGNED NOT NULL DEFAULT 1,
  default_currency       CHAR(3)          NOT NULL DEFAULT 'USD',
  processing_mode        VARCHAR(20)      NOT NULL DEFAULT 'automatic',
  payment_instructions   TEXT             NULL,
  minimum_deposit_minor  BIGINT           NOT NULL DEFAULT 1000,
  minimum_withdrawal_minor BIGINT         NOT NULL DEFAULT 1000,
  updated_by              CHAR(36)        NULL,
  created_at             DATETIME(3)      NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at             DATETIME(3)      NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                        ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT chk_payment_settings_singleton  CHECK (id = 1),
  CONSTRAINT chk_payment_settings_currency    CHECK (default_currency IN ('USD', 'EUR', 'NGN')),
  CONSTRAINT chk_payment_settings_mode        CHECK (processing_mode IN ('automatic', 'manual_review')),
  CONSTRAINT chk_payment_settings_min_deposit CHECK (minimum_deposit_minor >= 0),
  CONSTRAINT chk_payment_settings_min_withdraw CHECK (minimum_withdrawal_minor >= 0),
  CONSTRAINT fk_payment_settings_admin
    FOREIGN KEY (updated_by) REFERENCES admins (id) ON DELETE SET NULL
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci;

-- ---------------------------------------------------------------------------
-- Daily aggregate rollups for the dashboard cards that the brief places out of
-- functional scope (deposits, investments). EVERY row here is demo data:
-- `is_demo` defaults to 1 and nothing in this application ever writes to it.
-- Real counts (users, pending withdrawals) are computed from live tables
-- instead and are not stored here.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS platform_metrics_daily (
  metric_date  DATE      NOT NULL,
  metric_key   VARCHAR(40) NOT NULL,
  amount_minor BIGINT     NOT NULL DEFAULT 0,
  count_value  BIGINT     NOT NULL DEFAULT 0,
  is_demo      TINYINT(1) NOT NULL DEFAULT 1,
  CONSTRAINT chk_platform_metrics_demo CHECK (is_demo IN (0, 1)),
  PRIMARY KEY (metric_date, metric_key),
  KEY idx_platform_metrics_key (metric_key, metric_date)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci;

-- ---------------------------------------------------------------------------
-- Audit trail for administrative changes.
-- NEVER store passwords, password hashes, tokens, cookies or any credential
-- here. The audit service redacts a fixed deny-list before persisting.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_log (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  actor_admin_id CHAR(36)        NULL,
  actor_email    VARCHAR(254)    NULL,
  action         VARCHAR(80)     NOT NULL,
  entity_type    VARCHAR(60)     NOT NULL,
  entity_id      VARCHAR(64)     NULL,
  summary        VARCHAR(500)    NOT NULL,
  before_json    JSON            NULL,
  after_json     JSON            NULL,
  ip             VARCHAR(45)     NULL,
  user_agent     VARCHAR(255)    NULL,
  created_at     DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_audit_log_created (created_at),
  KEY idx_audit_log_actor (actor_admin_id),
  KEY idx_audit_log_entity (entity_type, entity_id)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci;
