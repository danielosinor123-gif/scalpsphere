/**
 * Audit trail.
 *
 * Every administrative change is written to `audit_log`.
 *
 * HARD RULE: no password, password hash, access token, refresh token, cookie or
 * any other credential is ever persisted. `redact()` walks the value and
 * replaces the deny-listed keys before the row is written, and
 * `assertSafeToAudit()` refuses the write entirely if a deny-listed key survives.
 */
const DENY_EXACT = new Set([
  'password',
  'password_hash',
  'passwordhash',
  'passwordhashconfirm',
  'new_password',
  'newpassword',
  'current_password',
  'currentpassword',
  'token',
  'access_token',
  'accesstoken',
  'refresh_token',
  'refreshtoken',
  'csrf_token',
  'csrftoken',
  'secret',
  'client_secret',
  'authorization',
  'cookie',
  'set-cookie',
  'api_key',
  'apikey',
  'private_key',
  'privatekey',
  'wallet_key',
  'walletkey',
  'seed_phrase',
  'seedphrase',
  'mnemonic',
  'card_number',
  'cardnumber',
  'cvv',
  'iban',
  'account_number',
]);

const DENY_SUBSTRINGS = [
  'password',
  'passwd',
  'secret',
  'token',
  'authorization',
  'cookie',
  'api_key',
  'apikey',
  'private_key',
  'private_key',
  'mnemonic',
  'seed_phrase',
  'cvv',
  'iban',
  'card_number',
];

const SENSITIVE_EMAIL_HINT = '@';

function normalizeKey(key) {
  return String(key).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isSensitiveKey(key) {
  const normalized = normalizeKey(key);
  if (DENY_EXACT.has(normalized)) return true;
  return DENY_SUBSTRINGS.some((needle) => normalized.includes(needle));
}

/**
 * Replace sensitive values with a placeholder. Nested objects and arrays are
 * walked to a bounded depth.
 */
export function redact(value, depth = 0) {
  if (depth > 5) return '[TRUNCATED]';
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value instanceof Date) return value.toISOString();

  const out = {};
  for (const [key, val] of Object.entries(value)) {
    if (isSensitiveKey(key)) {
      out[key] = '[REDACTED]';
    } else {
      out[key] = redact(val, depth + 1);
    }
  }
  return out;
}

/** Defensive check — throws rather than writing an unsafe row. */
export function assertSafeToAudit(label, value) {
  if (!value || typeof value !== 'object') return;
  for (const key of Object.keys(value)) {
    if (isSensitiveKey(key)) {
      throw new Error(
        `Refusing to write audit entry "${label}": field "${key}" is sensitive and must not be logged.`,
      );
    }
  }
}

function summarize(before, after, diffKeys) {
  if (diffKeys.length === 0) return 'No field changes.';
  const parts = diffKeys.map((k) => `${k}: ${fmt(before?.[k])} → ${fmt(after?.[k])}`);
  return parts.join(', ').slice(0, 500);
}

function fmt(v) {
  if (v === undefined) return '∅';
  if (v === null) return 'null';
  if (typeof v === 'string') return v.length > 60 ? `${v.slice(0, 57)}…` : v;
  return String(v);
}

export function createAuditService(repos) {
  /**
   * @param {object} entry
   *   { req, adminId, adminEmail, action, entityType, entityId, summary,
   *     before, after }
   */
  async function record(entry) {
    const before = entry.before ? redact(entry.before) : null;
    const after = entry.after ? redact(entry.after) : null;
    assertSafeToAudit(entry.action, before);
    assertSafeToAudit(entry.action, after);

    const diffKeys =
      before && after
        ? Object.keys(after).filter((k) => k !== 'updated_at' && fmt(before[k]) !== fmt(after[k]))
        : [];

    const summary =
      entry.summary ?? summarize(before, after, diffKeys);

    return repos.auditRepo.insert({
      actor_admin_id: entry.adminId ?? null,
      actor_email: entry.adminEmail ?? null,
      action: entry.action,
      entity_type: entry.entityType,
      entity_id: entry.entityId ? String(entry.entityId) : null,
      summary,
      before_json: before,
      after_json: after,
      ip: entry.req?.clientIp ?? null,
      user_agent: entry.req?.userAgent?.slice(0, 255) ?? null,
    });
  }

  return {
    record,
    list: (params) => repos.auditRepo.list(params),
    count: () => repos.auditRepo.count(),
  };
}

export { SENSITIVE_EMAIL_HINT };
