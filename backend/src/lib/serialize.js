/**
 * Response shaping. Every entity is serialised once, here, so the JSON field
 * names documented in openapi.yaml are guaranteed to match what the API emits.
 *
 * Naming rules:
 *  - snake_case for every JSON key.
 *  - `id` is the short public reference (e.g. `USR-00001`, `WDR-00001`,
 *    `PAY-00001`) — the same value the supplied admin.html shows in its ID
 *    column, and the value used in detail URLs. Internal UUID primary keys are
 *    never exposed.
 *  - money is exposed as BOTH `*_minor` (integer minor units) and `*_display`
 *    (the pre-formatted string the HTML renders, e.g. "$450.00").
 */
import { formatMinor } from './money.js';

function currencyOrDefault(currency) {
  return currency || 'USD';
}

export function serializeAdmin(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    full_name: row.full_name,
    role: row.role,
    status: row.status,
    last_login_at: row.last_login_at ? new Date(row.last_login_at).toISOString() : null,
    created_at: new Date(row.created_at).toISOString(),
  };
}

/**
 * @param {object} row   users row (balance_minor, kyc_status, ...)
 * @param {string} currency  default currency for display formatting
 */
export function serializeUser(row, currency = 'USD') {
  if (!row) return null;
  return {
    id: row.public_ref,
    name: row.full_name,
    username: row.username ?? null,
    email: row.email,
    balance_minor: Number(row.balance_minor),
    balance_display: formatMinor(Number(row.balance_minor), currencyOrDefault(currency)),
    currency: row.currency || currencyOrDefault(currency),
    status: row.status,
    kyc_status: row.kyc_status,
    is_demo: Boolean(row.is_demo),
    created_at: new Date(row.created_at).toISOString(),
    updated_at: row.updated_at ? new Date(row.updated_at).toISOString() : null,
  };
}

export function serializeWithdrawal(row, currency = 'USD') {
  if (!row) return null;
  const amountMinor = Number(row.amount_minor);
  const feeMinor = Number(row.fee_minor);
  return {
    id: row.public_ref,
    user_ref: row.user_ref ?? null,
    client_name: row.client_name ?? null,
    amount_minor: amountMinor,
    amount_display: formatMinor(amountMinor, currencyOrDefault(currency)),
    fee_minor: feeMinor,
    fee_display: formatMinor(feeMinor, currencyOrDefault(currency)),
    net_minor: amountMinor - feeMinor,
    net_display: formatMinor(amountMinor - feeMinor, currencyOrDefault(currency)),
    payment_method: row.method,
    receiver_email: row.receiver_email,
    status: row.status,
    is_demo: Boolean(row.is_demo),
    created_at: new Date(row.created_at).toISOString(),
    updated_at: row.updated_at ? new Date(row.updated_at).toISOString() : null,
  };
}

export function serializePaymentMethod(row) {
  if (!row) return null;
  return {
    id: row.public_ref,
    name: row.name,
    type: row.type,
    used_for: row.used_for,
    status: row.status,
    is_demo: Boolean(row.is_demo),
    created_at: new Date(row.created_at).toISOString(),
    updated_at: row.updated_at ? new Date(row.updated_at).toISOString() : null,
  };
}

export function serializePaymentSettings(row, { updated_by_email = null } = {}) {
  if (!row) return null;
  return {
    default_currency: row.default_currency,
    processing_mode: row.processing_mode,
    payment_instructions: row.payment_instructions,
    minimum_deposit_minor: Number(row.minimum_deposit_minor),
    minimum_deposit_display: formatMinor(Number(row.minimum_deposit_minor), row.default_currency),
    minimum_withdrawal_minor: Number(row.minimum_withdrawal_minor),
    minimum_withdrawal_display: formatMinor(Number(row.minimum_withdrawal_minor), row.default_currency),
    updated_by: row.updated_by ?? null,
    updated_by_email,
    updated_at: row.updated_at ? new Date(row.updated_at).toISOString() : null,
  };
}

export function serializeAuditEntry(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    action: row.action,
    entity_type: row.entity_type,
    entity_id: row.entity_id,
    summary: row.summary,
    actor: { id: row.actor_admin_id, email: row.actor_email },
    before: row.before_json ?? null,
    after: row.after_json ?? null,
    created_at: new Date(row.created_at).toISOString(),
  };
}
