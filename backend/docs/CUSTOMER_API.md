# Customer Portal API — Contract

Base path: **`/api/v1/customer`**
Content type: `application/json`
Audience: customer portal only — these routes are in a **separate token domain**
from the admin API and the two cannot be used interchangeably (see §2).

This document is the authoritative contract for the customer backend. The
admin API is documented separately in
[`API_CONTRACT.md`](./API_CONTRACT.md); both read the **same** tables.

---

## 0. Relationship to the admin backend

This is **not** a second system. There is one database and one set of tables:

| Concern | Table | Who writes it | Who reads it |
|---|---|---|---|
| Identity / profile / balance | `users` | admin panel (all fields), customer (`full_name` only) | both |
| Portal password | `customer_auth` | CLI `customer:credentials` | customer login only |
| Portal sessions | `customer_sessions` | login/refresh/logout | login only |
| Withdrawal history | `withdrawals` | admin panel | both |
| Payment methods | `payment_methods` | admin panel | both |
| Currency / minimums | `payment_settings` | admin panel | both |

A change made in the admin panel is immediately visible to the affected
customer, and vice versa — there is no sync step because there is no second
copy. `tests/customer-data.test.js` asserts this end-to-end.

---

## 1. Endpoints

### Authentication (public — no token required)

| Method | Path | Purpose |
|---|---|---|
| POST | `/customer/auth/login` | Sign in |
| POST | `/customer/auth/refresh` | Rotate the refresh session |
| POST | `/customer/auth/logout` | Revoke the current session |

### Authenticated customer

| Method | Path | Purpose |
|---|---|---|
| GET | `/customer/auth/session` | Current customer + member-since |
| GET | `/customer/profile` | Profile |
| PATCH | `/customer/profile` | Update `full_name` (the only permitted field) |
| GET | `/customer/dashboard/summary` | Real fields + explicit `unavailable` blocks |
| GET | `/customer/withdrawals` | Paginated history, ownership-scoped |
| GET | `/customer/withdrawals/:id` | One record, ownership-checked |
| GET | `/customer/kyc` | Status metadata only |
| GET | `/customer/payment-methods?used_for=deposit\|withdraw` | Enabled methods |

**No registration endpoint exists.** Whether the product has public
self-service sign-up is an open business decision (§6); provisioning today is
done by an operator via `npm run customer:credentials`.

---

## 2. Token domain separation

Admin tokens and customer tokens share one signing secret but carry **different
JWT audiences**, and each domain's verifier checks its own audience:

| | Admin API | Customer API |
|---|---|---|
| `aud` | `JWT_AUDIENCE` (default `scalpsphere-admin`) | `JWT_CUSTOMER_AUDIENCE` (default `scalpsphere-customer`) |
| `typ` claim | `access` | `customer_access` |
| access cookie | `access_token` | `cust_access_token` |
| refresh cookie | `refresh_token` | `cust_refresh_token` (path `/api/v1/customer/auth`) |
| subject table | `admins` | `users` (via `customer_auth`) |

Consequences, all covered by tests:

- A customer token used on an admin route → **401 `UNAUTHENTICATED`**.
- An admin token used on a customer route → **401 `UNAUTHENTICATED`**.
- The two sessions can coexist in one browser without clobbering each other.

Identity is **never** taken from a request parameter. `authenticateCustomer`
resolves `req.customerAuth.userId` from the signed token only; routes that take
no query parameters reject *any* query parameter with 422, so `?user_id=` cannot
even be smuggled in.

---

## 3. Response schemas

Every response uses the shared envelope from `API_CONTRACT.md`
(`{ success, data, meta? }`), the same error codes, and the same pagination
metadata.

### `POST /customer/auth/login`
```json
{
  "success": true,
  "data": {
    "customer": { "id": "USR-00001", "email": "trayson.white@example.com", "full_name": "Trayson Abraham White" },
    "access_token": "eyJ…",
    "token_type": "Bearer",
    "expires_in": 900,
    "csrf_token": "…",
    "session_expires_at": "2026-11-15T00:00:00.000Z"
  }
}
```
Sets `cust_access_token`, `cust_refresh_token` (both httpOnly) and `csrf_token`.
Failures: `401 INVALID_CREDENTIALS` (identical for unknown email and wrong
password — no account enumeration), `423 ACCOUNT_LOCKED`, `429 RATE_LIMITED`,
`422 VALIDATION_ERROR`. Eight failed attempts lock the account for
`LOGIN_LOCKOUT_MINUTES`.

### `GET /customer/auth/session` and `GET /customer/profile`
```json
{
  "success": true,
  "data": {
    "id": "USR-00001",
    "email": "trayson.white@example.com",
    "full_name": "Trayson Abraham White",
    "kyc_status": "verified",
    "member_since": "2026-10-14T18:00:00.000Z",
    "updated_at": "2026-10-16T00:00:00.000Z"
  }
}
```

### `PATCH /customer/profile`
Body: `{ "full_name": "New Name" }` (2–120 chars). **The only writable field.**
Balance, currency, status, `kyc_status`, email and `is_demo` are rejected with
422 — see `tests/customer-data.test.js`, which attempts each one.

### `GET /customer/dashboard/summary`
```json
{
  "success": true,
  "data": {
    "generated_at": "2026-10-16T01:00:00.000Z",
    "currency": "USD",
    "account": { "id": "USR-00001", "full_name": "…", "email": "…", "kyc_status": "verified", "member_since": "…" },
    "balance": {
      "minor": 45000, "display": "$450.00", "currency": "USD",
      "source": "users.balance_minor", "read_only": true
    },
    "withdrawals": { "total": 1, "pending_count": 1, "pending_minor": 53700, "source": "withdrawals" },
    "recent_withdrawals": [
      { "id": "WDR-00001", "amount_minor": 53700, "amount_display": "$537.00",
        "payment_method": "USDT", "status": "pending", "created_at": "…" }
    ],
    "unavailable": [
      { "feature": "performance_time_series", "reason": "No per-user performance data exists in the current data model." },
      { "feature": "investments",             "reason": "No investment plan terms or holdings model is defined." },
      { "feature": "staking",                 "reason": "No staking asset catalog, durations or reward rules are defined." },
      { "feature": "trading",                 "reason": "No order, position or strategy model is defined." },
      { "feature": "mirror_trading",          "reason": "No trader or strategy metadata model is defined." },
      { "feature": "deposit_history",         "reason": "No deposit records exist; only withdrawal history is modelled." },
      { "feature": "transaction_ledger",      "reason": "No unified transaction table exists. Withdrawal history is available separately." }
    ]
  }
}
```

**`balance` is a read-only projection of `users.balance_minor`** — the same row
the admin panel edits. It is never accepted from, or computed by, the client.

**The `unavailable` array is the honest part of this contract.** There is no
per-user performance, investment, staking, trading, deposit or transaction data
in the database, so those capabilities are named with a reason rather than
invented as numbers. A client must treat them as "not present in this release",
not as zero. When a backing model and business rules are defined, each entry is
removed and replaced by a real field.

### `GET /customer/withdrawals`
Same query parameters and row shape as the admin
`GET /withdrawals` (`API_CONTRACT.md` §3.5), but **always scoped to the
caller**: the `userId` filter is applied inside the repository and cannot be
supplied or removed by the client. A customer with no history gets
`data: []` with `pagination.total: 0`.

### `GET /customer/withdrawals/:id`
404 when the record does not exist **or** belongs to another customer — the two
are indistinguishable by design, so reference ids cannot be used to probe for
other users' records.

### `GET /customer/kyc`
```json
{ "success": true, "data": {
  "status": "verified",
  "last_updated_at": "2026-10-16T00:00:00.000Z",
  "documents_on_file": false,
  "note": "Status metadata only. This release does not collect, store or serve identity documents."
} }
```
Status metadata only. There is no document upload, storage or retrieval
anywhere in this API.

### `GET /customer/payment-methods?used_for=deposit|withdraw`
Returns only `status: "enabled"` methods whose `used_for` matches the request or
is `both`, sorted by name. Same `payment_methods` rows the admin panel edits;
the admin-only `is_demo` field is omitted from this projection.

---

## 4. Security properties

| Property | Enforcement |
|---|---|
| Password storage | bcrypt, cost `BCRYPT_ROUNDS` (12 default) |
| Refresh tokens | opaque random, stored SHA-256 only, rotated on every refresh, revoked on logout |
| CSRF | double-submit cookie, required for PATCH (and refresh/logout) when cookie-authenticated |
| Rate limiting | dedicated limiter on both login surfaces, per IP+email, failed attempts only |
| Lockout | 8 failed attempts → `423` for `LOGIN_LOCKOUT_MINUTES` |
| Ownership | enforced in middleware + repository; detail lookups return 404, not 403 |
| SQL | parameterised everywhere; sort/filter from allowlists |
| Errors | same safe envelope as the admin API; no stack traces, no driver text |
| CORS | same explicit allow-list; `CORS_ALLOWED_ORIGINS` must list the customer app origin |

Known trade-off (identical to the admin domain): a customer access token is a
stateless 15-minute JWT, so logout revokes the *refresh* session rather than
invalidating an already-issued access token. `docs/SECURITY.md` §2.2 explains
the reasoning.

---

## 5. Provisioning a customer

There is no public registration. An operator attaches a portal password to an
existing `users` row:

```bash
CUSTOMER_PASSWORD="$(openssl rand -base64 18)" \
  npm run customer:credentials -- --email someone@example.com
```

The account must already exist in the admin-managed `users` table; the CLI
refuses otherwise. Customer identity is created by the admin panel, never by
the portal.

For local development, `npm run seed` gives the demo users a shared, clearly
synthetic password (printed by the command) so the portal is usable immediately.

---

## 6. Open business decisions

These are **not** technical gaps; they are product rules nobody has defined yet.
Each needs an answer before the corresponding capability can be built:

1. **Registration.** Is customer self-service sign-up a requirement? If yes,
   what fields, what email verification flow, and what KYC gate applies before
   login?
2. **Balance semantics.** `users.balance_minor` is currently a display figure
   the admin panel edits. What is its authoritative source of truth — deposits
   minus withdrawals, a ledger, or an external system?
3. **Performance / returns.** Are per-user performance figures a requirement,
   and from what data?
4. **Investment plans / staking / trading.** Terms, durations, fees, reward
   rules, risk disclosures — all undefined. No model can be built without them.
5. **Deposits and transactions.** Should there be a unified transaction ledger
   backing the admin "Manage Deposits" placeholder and the customer history?
6. **Email address changes.** Requires an ownership-verification flow that does
   not exist; the field is deliberately read-only until that is specified.
7. **Customer activity audit.** Admin actions are audited in `audit_log`.
   Should customer sign-ins and profile edits have their own trail? Currently
   they do not write to the admin audit log, by design.
