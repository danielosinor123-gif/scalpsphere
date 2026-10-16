/**
 * CUSTOMER PORTAL API  —  /api/v1/customer/...
 *
 * Scope of this release, and the reason for every omission:
 *
 *   IMPLEMENTED (backed by the shared schema)
 *     POST   /customer/auth/login        sign in (email + password)
 *     POST   /customer/auth/refresh      rotate the refresh session
 *     POST   /customer/auth/logout       revoke the current session
 *     GET    /customer/auth/session      current authenticated customer
 *     GET    /customer/profile           profile + member-since
 *     PATCH  /customer/profile           update the ONE safe field (full_name)
 *     GET    /customer/dashboard/summary real fields + explicit unavailable blocks
 *     GET    /customer/withdrawals       paginated history, ownership-scoped
 *     GET    /customer/withdrawals/:id   single record, ownership-checked
 *     GET    /customer/kyc               status metadata only
 *     GET    /customer/payment-methods   enabled methods actually configured
 *
 *   NOT IMPLEMENTED, AND WHY
 *     Registration            no product requirement exists for it yet — adding
 *                             a public sign-up flow would be inventing one.
 *     Investment plans        no table, no business rules, no defined terms.
 *     Staking                 no table, no durations, no reward rules.
 *     Trading / mirror trading no table, no order model, no strategy metadata.
 *     Transactions ledger      no such table; the only per-user financial
 *                             history that exists is `withdrawals`.
 *     Deposits history         no such table.
 *     Notifications            no model, no delivery mechanism.
 *     Performance time-series  no per-user source; platform_metrics_daily is
 *                             an aggregate, not a customer's returns.
 *
 * Every unavailable capability is surfaced as an explicit `unavailable` block
 * with a reason rather than a fabricated number.
 *
 * ROUTING NOTE — the guard is scoped to a sub-router on purpose.
 *   These routes are registered on an inner express.Router() that is mounted at
 *   `/customer`, and `customer.use(customerAuth)` is applied to THAT router
 *   only. A pathless `use()` on the shared top-level router would have applied
 *   customer authentication to every route registered after it — including the
 *   admin endpoints — which is exactly the class of accidental cross-domain
 *   coupling this module must never introduce. (It did once, during
 *   development, and was caught by the admin test suite.)
 *
 * SECURITY PROPERTIES
 *   * The caller's user id comes from the signed token (req.customerAuth), set
 *     by `authenticateCustomer`. No route reads a user id from a parameter, so
 *     account isolation cannot be bypassed by a handler forgetting to check.
 *   * Tokens are audience-scoped to the customer domain; an admin token is
 *     rejected here and a customer token is rejected by admin routes.
 *   * All reads and the single write are parameterised; sort/filter values are
 *     allowlisted exactly as the admin endpoints are.
 *   * Nothing in this module mutates a balance, a withdrawal, or any financial
 *     record. The only write is `users.full_name`.
 */
import { env } from '../../config/env.js';
import express from 'express';
import { randomToken, sha256, uuid } from '../../lib/ids.js';
import { asyncHandler, ok, paginated } from '../../lib/http.js';
import { parsePagination, buildPagination } from '../../lib/pagination.js';
import { validateOrThrow } from '../../lib/validation.js';
import {
  badRequest, invalidCredentials, accountLocked, unauthorized, notFound, validationError,
} from '../../lib/ApiError.js';
import { verifyPassword } from '../../lib/password.js';
import {
  signCustomerAccessToken, createRefreshToken,
} from '../../lib/tokens.js';
import { serializeWithdrawal, serializePaymentMethod } from '../../lib/serialize.js';
import { formatMinor } from '../../lib/money.js';
import {
  authenticateCustomer,
  CUST_ACCESS_COOKIE_NAME, CUST_REFRESH_COOKIE_NAME,
  custAccessCookieOptions, custRefreshCookieOptions,
} from '../../middleware/authenticateCustomer.js';
import { CSRF_COOKIE_NAME } from '../../middleware/csrf.js';
import { csrfCookieOptions } from '../../middleware/authenticate.js';
import bcrypt from 'bcryptjs';

/**
 * A valid bcrypt-shaped hash of a throwaway string, so "no such account" and
 * "wrong password" cost the same and response time cannot enumerate emails.
 */
const DUMMY_HASH = bcrypt.hashSync(randomToken(16), 4);

const LOGIN_SCHEMA = {
  email: { type: 'email', required: true, max: 254 },
  password: { type: 'string', required: true, min: 1, max: 128, trim: false },
};

// The ONLY field a customer may change. Email changes need an ownership
// verification flow that does not exist; balance, status, KYC and currency are
// admin-owned or financial and are rejected outright.
const PROFILE_PATCH_SCHEMA = {
  full_name: { type: 'string', required: true, min: 2, max: 120 },
};

const WITHDRAWALS_QUERY_SCHEMA = {
  page: { type: 'integer', min: 1, max: 1000000 },
  per_page: { type: 'integer', min: 1, max: 100 },
  status: { type: 'enum', values: ['pending', 'processed', 'failed', 'cancelled'] },
  method: { type: 'string', max: 80 },
  from: {
    type: 'string', max: 40,
    pattern: /^\d{4}-\d{2}-\d{2}([T ].*)?$/,
    patternMessage: 'Use an ISO-8601 date (YYYY-MM-DD).',
  },
  to: {
    type: 'string', max: 40,
    pattern: /^\d{4}-\d{2}-\d{2}([T ].*)?$/,
    patternMessage: 'Use an ISO-8601 date (YYYY-MM-DD).',
  },
  sort: { type: 'enum', values: ['created_at', 'amount', 'fee', 'status', 'id'], default: 'created_at' },
  direction: { type: 'enum', values: ['asc', 'desc'], default: 'desc' },
};

const METHODS_QUERY_SCHEMA = {
  used_for: { type: 'enum', values: ['deposit', 'withdraw'], default: 'deposit' },
};

/** Capabilities with no backing model. Never fabricated as numbers. */
const UNAVAILABLE = [
  { feature: 'performance_time_series', reason: 'No per-user performance data exists in the current data model.' },
  { feature: 'investments', reason: 'No investment plan terms or holdings model is defined.' },
  { feature: 'staking', reason: 'No staking asset catalog, durations or reward rules are defined.' },
  { feature: 'trading', reason: 'No order, position or strategy model is defined.' },
  { feature: 'mirror_trading', reason: 'No trader or strategy metadata model is defined.' },
  { feature: 'deposit_history', reason: 'No deposit records exist; only withdrawal history is modelled.' },
  { feature: 'transaction_ledger', reason: 'No unified transaction table exists. Withdrawal history is available separately.' },
];

function accessTtlSeconds() {
  const match = /^(\d+)([smhd])$/.exec(String(env.auth.accessTtl).trim());
  if (!match) return 900;
  const value = Number(match[1]);
  const unit = { s: 1, m: 60, h: 3600, d: 86400 }[match[2]];
  return value * unit;
}

/**
 * Rejects any query parameter at all. Used on the endpoints that take none, so
 * that a caller cannot smuggle in something like ?user_id= — even though the
 * handler would ignore it — and so every customer endpoint is as strict about
 * its inputs as the admin list endpoints are about theirs.
 */
function rejectQueryParams(req) {
  const keys = Object.keys(req.query ?? {});
  if (keys.length > 0) {
    throw validationError(
      keys.map((field) => ({ field, message: 'Unknown query parameter.' })),
    );
  }
}

export function createCustomerModule({ repos, settings }) {
  const customerAuth = authenticateCustomer({ repos });

  function setAuthCookies(res, { accessToken, refreshToken, csrfToken }) {
    res.cookie(CUST_ACCESS_COOKIE_NAME, accessToken, custAccessCookieOptions());
    res.cookie(CUST_REFRESH_COOKIE_NAME, refreshToken, custRefreshCookieOptions());
    res.cookie(CSRF_COOKIE_NAME, csrfToken, csrfCookieOptions());
  }

  function clearAuthCookies(res) {
    res.clearCookie(CUST_ACCESS_COOKIE_NAME, custAccessCookieOptions());
    res.clearCookie(CUST_REFRESH_COOKIE_NAME, custRefreshCookieOptions());
    res.cookie(CSRF_COOKIE_NAME, '', { ...csrfCookieOptions(), maxAge: 0 });
  }

  async function issueSession(user, req) {
    const csrfToken = randomToken(32);
    const accessToken = signCustomerAccessToken(user);
    const { token: refreshToken, tokenHash, expiresAt } = createRefreshToken();

    await repos.customerSessionRepo.create({
      id: uuid(),
      userId: user.id,
      refreshTokenHash: tokenHash,
      expiresAt,
      ip: req.clientIp,
      userAgent: req.userAgent,
    });

    return { accessToken, refreshToken, csrfToken, expiresAt };
  }

  return function register(router) {
    // Inner router, mounted at /customer below. Everything the customer portal
    // exposes lives here so that no middleware can leak onto an admin route.
    const customer = express.Router();

    // -----------------------------------------------------------------
    // Authentication (public)
    // -----------------------------------------------------------------
    customer.post(
      '/auth/login',
      asyncHandler(async (req, res) => {
        const { email, password } = validateOrThrow(LOGIN_SCHEMA, req.body ?? {});

        const record = await repos.customerAuthRepo.findActiveByUserEmail(email);

        const passwordMatches = await verifyPassword(
          password,
          record ? record.password_hash : DUMMY_HASH,
        );

        if (!record || !passwordMatches) {
          if (record) {
            const updated = await repos.customerAuthRepo.recordLoginFailure(
              record.user_id,
              env.auth.loginMaxAttempts,
              new Date(Date.now() + env.auth.loginLockoutMinutes * 60 * 1000),
            );
            if (updated.locked_until && new Date(updated.locked_until) > new Date()) {
              throw accountLocked(new Date(updated.locked_until));
            }
          }
          // Never disclose whether the account exists.
          throw invalidCredentials();
        }

        if (record.status !== 'active') {
          throw unauthorized('Portal access is not enabled for this account.');
        }
        if (record.user_status !== 'active') {
          throw unauthorized('This account is not active.');
        }
        if (record.locked_until && new Date(record.locked_until) > new Date()) {
          throw accountLocked(new Date(record.locked_until));
        }

        await repos.customerAuthRepo.recordLoginSuccess(record.user_id);
        const session = await issueSession(
          { id: record.user_id, email: record.email, full_name: record.full_name },
          req,
        );
        setAuthCookies(res, session);

        return ok(res, {
          customer: {
            id: record.public_ref,
            email: record.email,
            full_name: record.full_name,
          },
          access_token: session.accessToken,
          token_type: 'Bearer',
          expires_in: accessTtlSeconds(),
          csrf_token: session.csrfToken,
          session_expires_at: session.expiresAt.toISOString(),
        });
      }),
    );

    customer.post(
      '/auth/refresh',
      asyncHandler(async (req, res) => {
        const raw = req.cookies?.[CUST_REFRESH_COOKIE_NAME];
        if (!raw) throw unauthorized('No refresh token present.');

        const session = await repos.customerSessionRepo.findValidByTokenHash(sha256(raw), new Date());
        if (!session) throw unauthorized('Refresh token is invalid, expired or revoked.');

        const user = await repos.userRepo.findById(session.user_id);
        if (!user || user.status !== 'active') {
          throw unauthorized('Session subject no longer exists.');
        }
        const cred = await repos.customerAuthRepo.findByUserId(user.id);
        if (!cred || cred.status !== 'active') {
          throw unauthorized('Portal access is not enabled for this account.');
        }

        // Rotate: the presented token is revoked and a fresh one issued.
        await repos.customerSessionRepo.revoke(session.id, 'rotated', new Date());
        const next = await issueSession(user, req);
        setAuthCookies(res, next);

        return ok(res, {
          access_token: next.accessToken,
          token_type: 'Bearer',
          expires_in: accessTtlSeconds(),
          csrf_token: next.csrfToken,
          session_expires_at: next.expiresAt.toISOString(),
        });
      }),
    );

    customer.post(
      '/auth/logout',
      asyncHandler(async (req, res) => {
        const raw = req.cookies?.[CUST_REFRESH_COOKIE_NAME];
        if (raw) {
          const session = await repos.customerSessionRepo.findValidByTokenHash(sha256(raw), new Date());
          if (session) {
            await repos.customerSessionRepo.revoke(session.id, 'logout', new Date());
          }
        }
        clearAuthCookies(res);
        return ok(res, { logged_out: true });
      }),
    );

    // Everything below requires an authenticated customer. This `use` applies
    // to the customer sub-router ONLY — never to the shared admin router.
    customer.use(customerAuth);

    // -----------------------------------------------------------------
    // Session
    // -----------------------------------------------------------------
    customer.get(
      '/auth/session',
      asyncHandler(async (req, res) => {
        rejectQueryParams(req);
        const user = await repos.userRepo.findById(req.customerAuth.userId);
        if (!user) throw unauthorized('Session subject no longer exists.');
        return ok(res, {
          id: user.public_ref,
          email: user.email,
          full_name: user.full_name,
          kyc_status: user.kyc_status,
          member_since: new Date(user.created_at).toISOString(),
        });
      }),
    );

    // -----------------------------------------------------------------
    // Profile
    // -----------------------------------------------------------------
    customer.get(
      '/profile',
      asyncHandler(async (req, res) => {
        rejectQueryParams(req);
        const user = await repos.userRepo.findById(req.customerAuth.userId);
        if (!user) throw notFound('Account not found.');
        return ok(res, {
          id: user.public_ref,
          email: user.email,
          full_name: user.full_name,
          kyc_status: user.kyc_status,
          member_since: new Date(user.created_at).toISOString(),
          updated_at: user.updated_at ? new Date(user.updated_at).toISOString() : null,
        });
      }),
    );

    customer.patch(
      '/profile',
      asyncHandler(async (req, res) => {
        const { full_name } = validateOrThrow(PROFILE_PATCH_SCHEMA, req.body ?? {});
        const user = await repos.userRepo.findById(req.customerAuth.userId);
        if (!user) throw notFound('Account not found.');

        // The ONLY field this endpoint can touch. Every other column on `users`
        // is either financial (balance_minor, currency), admin-owned (status,
        // kyc_status) or identity-critical (email, public_ref), and changing any
        // of them is out of scope for a self-service profile update.
        const updated = await repos.userRepo.updateFullName(req.customerAuth.userId, full_name);
        if (!updated) throw notFound('Account not found.');

        return ok(res, {
          id: updated.public_ref,
          email: updated.email,
          full_name: updated.full_name,
          kyc_status: updated.kyc_status,
          member_since: new Date(updated.created_at).toISOString(),
          updated_at: new Date(updated.updated_at).toISOString(),
        });
      }),
    );

    // -----------------------------------------------------------------
    // Dashboard summary — real fields only, gaps stated explicitly
    // -----------------------------------------------------------------
    customer.get(
      '/dashboard/summary',
      asyncHandler(async (req, res) => {
        rejectQueryParams(req);
        const user = await repos.userRepo.findById(req.customerAuth.userId);
        if (!user) throw notFound('Account not found.');

        const currency = (await settings.get())?.default_currency ?? 'USD';
        const mine = await repos.withdrawalRepo.list({
          userId: req.customerAuth.userId,
          limit: 100,
          offset: 0,
        });
        const pending = mine.rows.filter((w) => w.status === 'pending');

        return ok(res, {
          generated_at: new Date().toISOString(),
          currency,
          // --- real, shared with the admin panel --------------------------------
          account: {
            id: user.public_ref,
            full_name: user.full_name,
            email: user.email,
            kyc_status: user.kyc_status,
            member_since: new Date(user.created_at).toISOString(),
          },
          balance: {
            // Read straight from the users row the admin panel manages. This
            // endpoint never accepts or computes a balance.
            minor: Number(user.balance_minor),
            display: formatMinor(Number(user.balance_minor), currency),
            currency: user.currency || currency,
            source: 'users.balance_minor',
            read_only: true,
          },
          withdrawals: {
            total: mine.total,
            pending_count: pending.length,
            pending_minor: pending.reduce((sum, w) => sum + Number(w.amount_minor), 0),
            source: 'withdrawals',
          },
          recent_withdrawals: mine.rows.slice(0, 5).map((w) => ({
            id: w.public_ref,
            amount_minor: Number(w.amount_minor),
            amount_display: formatMinor(Number(w.amount_minor), currency),
            payment_method: w.method,
            status: w.status,
            created_at: new Date(w.created_at).toISOString(),
          })),
          // --- capabilities that have no backing model --------------------------
          unavailable: UNAVAILABLE,
        });
      }),
    );

    // -----------------------------------------------------------------
    // Withdrawal history (read-only, ownership-scoped)
    // -----------------------------------------------------------------
    customer.get(
      '/withdrawals',
      asyncHandler(async (req, res) => {
        const pagination = parsePagination(req.query, { defaultPerPage: 20, maxPerPage: 100 });
        const query = validateOrThrow(WITHDRAWALS_QUERY_SCHEMA, req.query ?? {});
        const currency = (await settings.get())?.default_currency ?? 'USD';

        const from = query.from ? new Date(query.from) : undefined;
        const to = query.to ? new Date(query.to) : undefined;
        if (from && to && from > to) {
          throw badRequest('"from" must be earlier than or equal to "to".');
        }

        const { rows, total } = await repos.withdrawalRepo.list({
          userId: req.customerAuth.userId,
          status: query.status,
          method: query.method,
          from,
          to,
          sort: query.sort,
          direction: query.direction,
          limit: pagination.limit,
          offset: pagination.offset,
        });

        return paginated(
          res,
          rows.map((r) => serializeWithdrawal(r, currency)),
          buildPagination(pagination.page, pagination.perPage, total),
        );
      }),
    );

    customer.get(
      '/withdrawals/:id',
      asyncHandler(async (req, res) => {
        const { id } = validateOrThrow(
          { id: { type: 'string', min: 1, max: 64, required: true } },
          req.params,
        );
        const currency = (await settings.get())?.default_currency ?? 'USD';

        // Ownership-checked: returns null when the row is missing OR belongs to
        // someone else, so a customer cannot probe other users' reference ids.
        const row = await repos.withdrawalRepo.findByIdForUser(id, req.customerAuth.userId);
        if (!row) throw notFound('No withdrawal request exists with that id.');
        return ok(res, serializeWithdrawal(row, currency));
      }),
    );

    // -----------------------------------------------------------------
    // KYC — status metadata only, never documents
    // -----------------------------------------------------------------
    customer.get(
      '/kyc',
      asyncHandler(async (req, res) => {
        rejectQueryParams(req);
        const user = await repos.userRepo.findById(req.customerAuth.userId);
        if (!user) throw notFound('Account not found.');
        return ok(res, {
          status: user.kyc_status,
          // Timestamp of the record itself. There is no document store and
          // this endpoint never returns, accepts or links to identity files.
          last_updated_at: user.updated_at ? new Date(user.updated_at).toISOString() : null,
          documents_on_file: false,
          note:
            'Status metadata only. This release does not collect, store or serve identity documents.',
        });
      }),
    );

    // -----------------------------------------------------------------
    // Payment methods actually configured (shared table, customer projection)
    // -----------------------------------------------------------------
    customer.get(
      '/payment-methods',
      asyncHandler(async (req, res) => {
        const { used_for } = validateOrThrow(METHODS_QUERY_SCHEMA, req.query ?? {});

        // Same `payment_methods` table and the same repository the admin panel
        // edits — one source of truth. The customer projection is narrower: it
        // only ever returns ENABLED methods usable for the requested direction.
        const { rows } = await repos.paymentMethodRepo.list({
          status: 'enabled',
          sort: 'name',
          direction: 'asc',
          limit: 100,
          offset: 0,
        });

        const usable = rows.filter((m) => m.used_for === used_for || m.used_for === 'both');
        return ok(res, usable.map(serializePaymentMethod));
      }),
    );

    // Mount the whole customer portal at /customer. This is the ONLY place the
    // shared router learns about it, and nothing outside /customer is affected.
    router.use('/customer', customer);
    return router;
  };
}
