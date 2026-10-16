# API Contract — ScalpSphere Admin Backend

Base path: **`/api/v1`**
Content type: `application/json` (UTF-8)
Authentication: session cookie (`access_token`, httpOnly) **or** `Authorization: Bearer <jwt>`

A machine-readable version of this document lives in
[`openapi.yaml`](../openapi.yaml).

---

## 1. Response envelope

Every response — success or failure — uses exactly one of these two shapes.

### Success

```json
{ "success": true, "data": { } }
```

Paginated responses add a `meta` object:

```json
{
  "success": true,
  "data": [ ],
  "meta": {
    "pagination": {
      "page": 1,
      "per_page": 20,
      "total": 42,
      "total_pages": 3,
      "has_next": true,
      "has_prev": false
    },
    "facets": { }
  }
}
```

`meta` also carries extra keys on list endpoints that support filtering
(`facets`, see §5).

### Error

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request validation failed.",
    "details": [
      { "field": "email", "message": "Must be a valid email address." }
    ],
    "request_id": "9f1c0b0e-4a5f-4d0e-9b1e-8f7c6d5b4a39"
  }
}
```

`request_id` is also returned in the `X-Request-Id` response header and in the
server log, so an operator can correlate a client report with the server-side
trace without the client ever seeing a stack trace.

### HTTP status codes used

| Status | Meaning |
|---|---|
| 200 | OK (GET, PATCH, PUT, POST that does not create) |
| 201 | Created (`POST /payment-methods`) |
| 204 | No content (`DELETE /payment-methods/:id`) |
| 400 | Malformed request body / bad date range |
| 401 | Missing, invalid or expired credentials (`UNAUTHENTICATED`) |
| 403 | Forbidden (`FORBIDDEN`) or CSRF failure (`CSRF_TOKEN_INVALID`) |
| 404 | No such route or resource (`NOT_FOUND`) |
| 405 | Method not allowed for this path |
| 409 | Uniqueness conflict (`CONFLICT`) |
| 413 | Body larger than 64 kB (`PAYLOAD_TOO_LARGE`) |
| 422 | Failed server-side validation (`VALIDATION_ERROR`) |
| 429 | Rate limit exceeded (`RATE_LIMITED`) |
| 500 | Unexpected server error (`INTERNAL_ERROR`) — always generic |
| 503 | Data layer unavailable (`SERVICE_UNAVAILABLE`) |

### Error codes

`UNAUTHENTICATED`, `INVALID_CREDENTIALS`, `ACCOUNT_LOCKED`, `ACCOUNT_DISABLED`,
`FORBIDDEN`, `CSRF_TOKEN_INVALID`, `NOT_FOUND`, `CONFLICT`, `VALIDATION_ERROR`,
`BAD_REQUEST`, `MALFORMED_JSON`, `PAYLOAD_TOO_LARGE`, `RATE_LIMITED`,
`INTERNAL_ERROR`, `SERVICE_UNAVAILABLE`.

---

## 2. Conventions

| Convention | Rule |
|---|---|
| JSON keys | `snake_case` |
| Money | always `*_minor` (integer **minor units**/cents) **and** `*_display` (the formatted string the HTML renders, e.g. `"$450.00"`) |
| Timestamps | ISO-8601 UTC strings, e.g. `2026-10-14T18:00:00.000Z` |
| Resource identifiers | short public references in URLs and in `id`: `USR-00001`, `WDR-00001`, `PAY-00001`. Internal UUID primary keys are never exposed. |
| Demo data | every seeded record carries `"is_demo": true`. Demo **aggregates** carry `"is_demo": true` plus `"source": "platform_metrics_daily"`. |
| Pagination | `page` (default 1), `per_page` (default 20, max 100) |
| Sorting | `sort` (whitelisted per endpoint) + `direction` (`asc` \| `desc`, default `desc`) |
| Unknown fields | rejected with 422 — prevents mass assignment |

---

## 3. Endpoints

### 3.1 Health (public)

#### `GET /api/v1/health`
No authentication. Returns process facts only — never hostnames, credentials or
versions.

```json
{
  "success": true,
  "data": {
    "status": "ok",
    "checks": { "database": "ok", "driver": "mysql", "durable": true },
    "uptime_seconds": 137,
    "api_version": "v1",
    "demo_environment": true,
    "authenticated_as": null
  }
}
```

> If `authenticated_as` is an authenticated caller, `authenticated_as` contains
> `{ id, email, role }`.

---

### 3.2 Authentication (public except where noted)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/auth/login` | – | Sign in |
| POST | `/auth/refresh` | refresh cookie | Rotate session |
| POST | `/auth/logout` | – | Revoke current session |
| POST | `/auth/logout-all` | required | Revoke every session |
| GET | `/auth/me` | required | Current principal |
| GET | `/auth/csrf` | – | Issue a CSRF token cookie |
| POST | `/auth/change-password` | required | Self-service password change |

#### `POST /auth/login`

Request:
```json
{ "email": "ops@example.com", "password": "…" }
```

Response `200`:
```json
{
  "success": true,
  "data": {
    "admin": { "id": "…", "email": "ops@example.com", "full_name": "Ops Owner", "role": "owner" },
    "access_token": "eyJhbGciOiJIUzI1NiIs…",
    "token_type": "Bearer",
    "expires_in": 900,
    "csrf_token": "n1xK…",
    "session_expires_at": "2026-11-13T18:00:00.000Z"
  }
}
```

Sets cookies:

| Cookie | httpOnly | Path | SameSite | Secure |
|---|---|---|---|---|
| `access_token` | yes | `/api/v1` | configurable (default `strict`) | configurable |
| `refresh_token` | yes | `/api/v1/auth` | as above | as above |
| `csrf_token` | **no** (readable by design) | `/` | as above | as above |

Failures:
- `401 INVALID_CREDENTIALS` — identical response for unknown account and wrong
  password, and the same bcrypt work is performed in both cases (no user
  enumeration through timing or message).
- `423 ACCOUNT_LOCKED` — after `LOGIN_MAX_ATTEMPTS` failed attempts, with
  `locked_until` in `details`.
- `422 VALIDATION_ERROR` — malformed email / unknown field.

#### `POST /auth/refresh`
Rotates the refresh token: the old one is revoked and a new one issued. Replaying
an old refresh token returns `401`.

#### `POST /auth/logout`
Revokes the presented refresh session and clears all three cookies.

#### `GET /auth/me`
```json
{
  "success": true,
  "data": {
    "id": "…", "email": "ops@example.com", "full_name": "Ops Owner",
    "role": "owner", "status": "active",
    "last_login_at": "2026-10-14T18:00:00.000Z"
  }
}
```

#### `GET /auth/csrf`
```json
{ "success": true, "data": { "csrf_token": "…", "header": "csrf_token" } }
```

#### `POST /auth/change-password`
Request: `{ "current_password": "…", "new_password": "…" }`
Response `200`: `{ "success": true, "data": { "password_changed": true, "sessions_revoked": true } }`
Password policy: ≥ 12 chars, upper, lower, number, symbol.

> **Note on access tokens after a password change.** Because access tokens are
> stateless JWTs, an already-issued access token stays valid until
> `JWT_ACCESS_TTL` expires (15 minutes by default). A password change revokes
> the refresh session so it cannot be extended, and `logout-all` is available to
> the administrator.

---

### 3.3 Dashboard (authenticated)

#### `GET /dashboard/summary`
Reproduces the four stat cards of `admin.html` with explicit provenance.

```json
{
  "success": true,
  "data": {
    "generated_at": "2026-10-14T18:00:00.000Z",
    "currency": "USD",
    "card_order": ["total_users", "total_deposits", "pending_withdrawals", "active_investments"],
    "cards": {
      "total_users": {
        "key": "total_users",
        "label": "Total users",
        "icon": "users",
        "value": 1284,
        "display_value": "1,284",
        "unit": "users",
        "source": "users_table",
        "is_demo": false,
        "trend": { "label": "+8.2% this month", "direction": "up", "is_demo": false }
      },
      "total_deposits": {
        "key": "total_deposits",
        "label": "Total deposits",
        "value": 8429000,
        "display_value": "$84,290.00",
        "unit": "USD",
        "source": "platform_metrics_daily",
        "is_demo": true,
        "trend": { "label": "Demo aggregate · deposits are out of scope", "direction": "flat", "is_demo": true }
      },
      "pending_withdrawals": {
        "key": "pending_withdrawals",
        "label": "Pending withdrawals",
        "value": 124700,
        "display_value": "$1,247.00",
        "unit": "USD",
        "count": 3,
        "source": "withdrawals_table",
        "is_demo": false,
        "trend": { "label": "3 requests awaiting", "direction": "flat", "is_demo": false }
      },
      "active_investments": {
        "key": "active_investments",
        "label": "Active investments",
        "value": 426,
        "display_value": "426",
        "unit": "investments",
        "source": "platform_metrics_daily",
        "is_demo": true,
        "trend": { "label": "Demo aggregate · investments are out of scope", "direction": "flat", "is_demo": true }
      }
    },
    "recent_withdrawals": [
      {
        "id": "WDR-00001",
        "client_name": "CHAN LYE KLUAN",
        "amount_minor": 53700,
        "amount_display": "$537.00",
        "payment_method": "USDT",
        "status": "pending",
        "created_at": "2026-10-14T18:00:00.000Z"
      }
    ],
    "recent_users": [
      {
        "id": "USR-00001",
        "name": "Trayson Abraham White",
        "email": "trayson.white@example.com",
        "balance_minor": 45000,
        "balance_display": "$450.00",
        "status": "active",
        "kyc_status": "verified",
        "created_at": "2026-10-14T18:00:00.000Z"
      }
    ],
    "activity": {
      "range": "7d",
      "days": 7,
      "is_demo": true,
      "points": [
        { "date": "2026-10-08", "deposits_minor": 420000, "withdrawals_minor": 140000, "is_demo": true }
      ],
      "note": "Aggregate deposit/withdrawal rollups are synthetic demo fixtures. This API does not implement deposits or withdrawals."
    }
  }
}
```

**Provenance rule (important):**
- `total_users` and `pending_withdrawals` are computed **live** from the `users`
  and `withdrawals` tables (`is_demo: false`).
- `total_deposits` and `active_investments` are read from the demo rollup table
  and are always flagged `is_demo: true`, because the brief places real deposits
  and investments out of scope. Nothing here is invented as a live financial
  figure.

#### `GET /dashboard/activity?range=7d|30d`
Returns the series powering the *Platform activity* chart. Same shape as
`data.activity` above.

#### `GET /dashboard/recent-users?limit=1..10`
Array of user objects (see §4.1). Default limit 5.

---

### 3.4 Users (authenticated, read-only)

#### `GET /users`

Query parameters (all optional, unknown keys → 422):

| Parameter | Type | Notes |
|---|---|---|
| `page` | integer ≥ 1 | default 1 |
| `per_page` | integer 1–100 | default 20 |
| `search` | string ≤ 120 | matches name, email, public reference |
| `status` | `active` \| `inactive` | |
| `kyc_status` | `pending` \| `verified` \| `rejected` | |
| `sort` | `created_at` \| `balance` \| `name` \| `id` \| `status` | default `created_at` |
| `direction` | `asc` \| `desc` | default `desc` |

```json
{
  "success": true,
  "data": [
    {
      "id": "USR-00001",
      "name": "Trayson Abraham White",
      "email": "trayson.white@example.com",
      "balance_minor": 45000,
      "balance_display": "$450.00",
      "currency": "USD",
      "status": "active",
      "kyc_status": "verified",
      "is_demo": true,
      "created_at": "2026-10-14T18:00:00.000Z",
      "updated_at": "2026-10-14T18:00:00.000Z"
    }
  ],
  "meta": {
    "pagination": { "page": 1, "per_page": 20, "total": 12, "total_pages": 1, "has_next": false, "has_prev": false },
    "facets": { "active": 8, "inactive": 4, "kyc_pending": 6, "kyc_verified": 6 }
  }
}
```

#### `GET /users/recent?limit=1..10`
Most recently registered users (dashboard panel). Array of user objects.

#### `GET /users/facets`
```json
{
  "success": true,
  "data": {
    "currency": "USD",
    "total": 12,
    "status": [
      { "key": "active", "label": "Active", "count": 8 },
      { "key": "inactive", "label": "Inactive", "count": 4 }
    ],
    "kyc_status": [
      { "key": "pending", "label": "Pending", "count": 6 },
      { "key": "verified", "label": "Verified", "count": 6 }
    ]
  }
}
```

#### `GET /users/:id`
Accepts a public reference (`USR-00001`) or the internal UUID. Returns the user
plus its five most recent withdrawal requests:

```json
{
  "success": true,
  "data": {
    "id": "USR-00001",
    "name": "…",
    "email": "…",
    "balance_minor": 45000,
    "balance_display": "$450.00",
    "currency": "USD",
    "status": "active",
    "kyc_status": "verified",
    "is_demo": true,
    "created_at": "…",
    "updated_at": "…",
    "recent_withdrawals": [ ]
  }
}
```

**No create/update/delete exists for users.** The brief scopes write endpoints to
the non-live demo payment-method configuration only.

---

### 3.5 Withdrawals (authenticated, read-only)

#### `GET /withdrawals`

| Parameter | Type | Notes |
|---|---|---|
| `page`, `per_page` | | as above |
| `search` | string ≤ 120 | matches client name, email, method, receiver email, reference |
| `status` | `pending` \| `processed` \| `failed` \| `cancelled` | |
| `method` | string ≤ 80 | exact match |
| `from` / `to` | `YYYY-MM-DD` or ISO datetime | inclusive range; `from` ≤ `to` required |
| `sort` | `created_at` \| `amount` \| `fee` \| `status` \| `id` | |
| `direction` | `asc` \| `desc` | |

```json
{
  "success": true,
  "data": [
    {
      "id": "WDR-00001",
      "user_ref": "USR-00001",
      "client_name": "CHAN LYE KLUAN",
      "amount_minor": 53700,
      "amount_display": "$537.00",
      "fee_minor": 53700,
      "fee_display": "$537.00",
      "net_minor": 0,
      "net_display": "$0.00",
      "payment_method": "USDT",
      "receiver_email": "sam_0309@hotmail.com",
      "status": "pending",
      "is_demo": true,
      "created_at": "2026-09-24T00:52:00.000Z",
      "updated_at": "2026-09-24T00:52:00.000Z"
    }
  ],
  "meta": {
    "pagination": { "page": 1, "per_page": 20, "total": 3, "total_pages": 1, "has_next": false, "has_prev": false }
  }
}
```

#### `GET /withdrawals/facets`
```json
{
  "success": true,
  "data": {
    "currency": "USD",
    "pending": { "count": 1, "amount_minor": 53700, "amount_display": "$537.00" },
    "statuses": ["pending", "processed", "failed", "cancelled"],
    "methods": ["Ethereum", "USDT"]
  }
}
```

#### `GET /withdrawals/:id`
Single withdrawal object, or `404`.

**Out of scope by instruction:** approving, rejecting, paying or cancelling a
withdrawal; contacting the receiver; any payment-provider call. This endpoint
models the review queue only.

---

### 3.6 Payment methods (authenticated, **write surface**)

Backs “Payment Settings → Payment Methods”. These rows are **display labels
only** — the API holds no wallet addresses, card data or provider credentials,
and moves no money.

#### `GET /payment-methods`

| Parameter | Type |
|---|---|
| `page`, `per_page` | pagination |
| `search` | matches name or reference |
| `type` | `crypto` \| `currency` |
| `used_for` | `deposit` \| `withdraw` \| `both` |
| `status` | `enabled` \| `disabled` |
| `sort` | `created_at` \| `name` \| `status` \| `type` \| `id` |
| `direction` | `asc` \| `desc` |

```json
{
  "success": true,
  "data": [
    {
      "id": "PAY-00001",
      "name": "USDT",
      "type": "crypto",
      "used_for": "both",
      "status": "enabled",
      "is_demo": true,
      "created_at": "2026-10-14T18:00:00.000Z",
      "updated_at": "2026-10-14T18:00:00.000Z"
    }
  ],
  "meta": {
    "pagination": { "page": 1, "per_page": 20, "total": 21, "total_pages": 2, "has_next": true, "has_prev": false },
    "facets": { "enabled": 3, "disabled": 18, "crypto": 18, "currency": 3 }
  }
}
```

#### `GET /payment-methods/facets`
`{ total, status: [{key,label,count}], type: [{key,label,count}], used_for: [...] }`

#### `GET /payment-methods/:id`
Single payment method, or `404`.

#### `POST /payment-methods` — role `owner` or `admin`
Request:
```json
{ "name": "Solana", "type": "crypto", "used_for": "both", "status": "disabled" }
```
- `name` 2–80 chars, unique (case-insensitive) → `409 CONFLICT` on duplicate.
- `status` optional, defaults to `disabled`.

Response `201` with the created method (`is_demo: false`).

#### `PATCH /payment-methods/:id` — role `owner` or `admin`
All fields optional. `409 CONFLICT` if the new name collides.

#### `POST /payment-methods/:id/enable` and `/disable` — role `owner` or `admin`
Sets `status` to `enabled` / `disabled`. Idempotent.

#### `DELETE /payment-methods/:id` — role `owner` or `admin`
Hard delete, matching the HTML Delete button. Returns `204`. `404` if missing.

Every write above records an audit entry with the before/after state.

---

### 3.7 Payment preferences / settings (authenticated)

Backs the “Payment Preference” form. The singleton row is created lazily on first
read with the HTML's own defaults (`USD`, `automatic`, `10.00`, `10.00`).

#### `GET /payment-settings`
```json
{
  "success": true,
  "data": {
    "default_currency": "USD",
    "processing_mode": "automatic",
    "payment_instructions": null,
    "minimum_deposit_minor": 1000,
    "minimum_deposit_display": "$10.00",
    "minimum_withdrawal_minor": 1000,
    "minimum_withdrawal_display": "$10.00",
    "updated_by": null,
    "updated_by_email": null,
    "updated_at": "2026-10-14T18:00:00.000Z"
  }
}
```

#### `GET /payment-settings/currencies`
```json
{
  "success": true,
  "data": {
    "default_currency": "USD",
    "currencies": [
      { "code": "USD", "label": "USD — US Dollar" },
      { "code": "NGN", "label": "NGN — Nigerian Naira" },
      { "code": "EUR", "label": "EUR — Euro" }
    ],
    "processing_modes": [
      { "key": "automatic", "label": "Automatic" },
      { "key": "manual_review", "label": "Manual review" }
    ]
  }
}
```

#### `PUT /payment-settings` — role `owner` or `admin`
All fields required:
```json
{
  "default_currency": "NGN",
  "processing_mode": "manual_review",
  "payment_instructions": "Demo instructions — replace before going live.",
  "minimum_deposit": "250.50",
  "minimum_withdrawal": 1000
}
```
`minimum_deposit` / `minimum_withdrawal` accept a decimal string **or** a number
and are converted to minor units using the currency in the payload. Amounts with
more decimal places than the currency supports, negative values, or values above
1,000,000.00 are rejected.

#### `PATCH /payment-settings` — role `owner` or `admin`
Partial update; omitted fields (including empty strings) are left untouched.
Returns the complete settings object.

Both writes record an audit entry (`payment_settings.updated`) with the
before/after values.

---

### 3.8 Audit log (authenticated, role `owner`)

#### `GET /audit-log?page=1&per_page=25&action=&entity_type=&from=&to=`

```json
{
  "success": true,
  "data": [
    {
      "id": "42",
      "action": "payment_method.created",
      "entity_type": "payment_method",
      "entity_id": "PAY-00001",
      "summary": "Created payment method Solana (crypto, both, disabled).",
      "actor": { "id": "…", "email": "ops@example.com" },
      "before": null,
      "after": { "name": "Solana", "type": "crypto", "used_for": "both", "status": "disabled" },
      "created_at": "2026-10-14T18:00:00.000Z"
    }
  ],
  "meta": { "pagination": { } }
}
```

Actions emitted: `auth.login_succeeded`, `auth.login_failed`, `auth.logout`,
`auth.logout_all`, `auth.session_refreshed`, `auth.password_changed`,
`payment_method.created`, `payment_method.updated`, `payment_method.enabled`,
`payment_method.disabled`, `payment_method.deleted`, `payment_settings.updated`.

**Credentials are never logged.** The audit service redacts a deny-list
(`password`, `token`, `secret`, `cookie`, `authorization`, `private_key`,
`mnemonic`, `cvv`, …) and *refuses to write* an entry if a deny-listed key
survives redaction.

The `/audit-log` route currently requires the `owner` role. Exposing it to a
lesser role is a deliberate deployment decision, not an omission.

---

## 4. Examples

### 4.1 Full user object / withdrawal object
See §3.4 and §3.5 above.

### 4.2 curl — authenticated write with CSRF

```bash
# 1. Sign in; cookies are stored in cookiejar.txt
curl -i -c cookiejar.txt -X POST http://localhost:4000/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"ops@example.com","password":"…"}'

# 2. Read the CSRF token from the response body
CSRF=$(curl -s -b cookiejar.txt http://localhost:4000/api/v1/auth/csrf | jq -r .data.csrf_token)

# 3. Create a payment method
curl -i -b cookiejar.txt -X POST http://localhost:4000/api/v1/payment-methods \
  -H "X-CSRF-Token: $CSRF" -H 'Content-Type: application/json' \
  -d '{"name":"Solana","type":"crypto","used_for":"both"}'
```

### 4.3 Token-only client (no cookies, so no CSRF requirement)

```bash
curl -H "Authorization: Bearer $ACCESS_TOKEN" \
     http://localhost:4000/api/v1/users?search=wright&per_page=10
```

---

## 5. In-scope vs out-of-scope

### Implemented
- `GET /health`
- Auth: login, refresh (with rotation), logout, logout-all, me, csrf,
  change-password
- `GET /dashboard/summary`, `/dashboard/activity`, `/dashboard/recent-users`
- `GET /users`, `/users/recent`, `/users/facets`, `/users/:id`
- `GET /withdrawals`, `/withdrawals/facets`, `/withdrawals/:id`
- `GET/POST/PATCH/DELETE /payment-methods`, `.../:id/enable`, `.../:id/disable`,
  `/payment-methods/facets`
- `GET/PUT/PATCH /payment-settings`, `/payment-settings/currencies`
- `GET /audit-log`
- Audit logging, role-based authorisation, rate limiting, CSRF, input validation

### Deliberately NOT implemented
- Real deposits, withdrawals, investments, trading, staking, crypto transfers.
- Real payment-provider integration (Coinpayment / card / bank gateways).
- KYC document collection or storage — `kyc_status` is a **status label only**.
- Email sending of any kind.
- Public user registration, password reset emails, public admin registration,
  and any endpoint that lists or creates administrators.
- The 13 admin nav items that render `genericPage()` placeholders in the
  supplied HTML (Investment, Manage Deposits, Email Services, KYC
  Application(s), Copy Trading, Bot Trading, Crypto Staking, Stock Trading,
  Crypto Trading, Manage Accounts, Task, Leads, Administrator(s), About Script).
  The HTML itself states these are front-end demos — there is no data model, no
  table and no workflow to back.
