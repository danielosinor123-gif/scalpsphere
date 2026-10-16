# Security Model

This document describes exactly how the backend is meant to be operated. It
exists so that a reviewer can check the claims instead of trusting them.

---

## 1. Threat surface

| Asset | Control |
|---|---|
| Admin password | bcrypt (cost 12 default, ≥ 10 enforced in production), never returned by any response, never written to logs or the audit trail |
| Access token | short-lived signed JWT (default 15 min); no sensitive claims |
| Refresh token | 384-bit random string, stored only as a SHA-256 hash, single-use, rotated on every refresh, revocable per admin |
| Session cookies | `httpOnly`, `SameSite=Strict` (configurable), `Secure` in production |
| CSRF | double-submit token; required for every unsafe method that authenticates via cookie |
| Database | parameterized SQL only; least-privilege app user; no user input ever becomes SQL text |
| Error responses | fixed envelope; no stack traces, SQL text, driver errors or secrets |
| Admin inventory | no public registration, no default password, no admin-listing endpoint |

---

## 2. Authentication

### 2.1 Provisioning an administrator (out of band)

There is no code path that creates an administrator over HTTP, and no default
admin password exists anywhere in the repository.

```bash
npm run admin:create
```

Recommended sequence for a brand-new deployment:

1. SSH into the host as the service user.
2. Ensure `.env` exists with a strong `JWT_ACCESS_SECRET`.
3. `npm run migrate`
4. Generate a password locally in a manager and inject it as an env var:

```bash
ADMIN_PASSWORD="$(openssl rand -base64 24)" \
  npm run admin:create -- --email ops@example.com --name "Ops Owner" --role owner
```

5. Store the password in the team's password manager and then **unset the
   variable in the shell** (`unset ADMIN_PASSWORD`).
6. Sign in at `POST /api/v1/auth/login`, and `POST /auth/change-password` on
   first use if the password was transmitted.

To rotate a compromised password:

```bash
npm run admin:set-password -- --email ops@example.com
# this also revokes every active session for that account
```

### 2.2 Token lifetimes

| Token | TTL | Revocable |
|---|---|---|
| Access JWT | `JWT_ACCESS_TTL` (default `15m`) | not individually (stateless); see note below |
| Refresh | `REFRESH_TOKEN_TTL_DAYS` (default 30) | yes — `logout`, `logout-all`, password change |

**Known JWT trade-off:** an access token that has already been issued stays valid
until it expires. A password change or `logout-all` revokes refresh sessions so
the stolen session cannot be extended. Keep `JWT_ACCESS_TTL` short (≤ 15 minutes)
so this window is small.

### 2.3 Brute-force protection

- `RATE_LIMIT_LOGIN_MAX` failed sign-ins per IP **and** email pair per
  `RATE_LIMIT_LOGIN_WINDOW_MS` (default 8 / 15 min). Successful logins are not
  counted (`skipSuccessfulRequests`).
- `LOGIN_MAX_ATTEMPTS` failures lock the account for
  `LOGIN_LOCKOUT_MINUTES` (`423 ACCOUNT_LOCKED`).
- bcrypt compares against a dummy hash for unknown emails, so "no such account"
  and "wrong password" cost the same and return the identical response.

Rate limiting is per-process. A multi-instance deployment must run behind a
reverse proxy (single ingress) or replace the store with a shared one.

---

## 3. Transport and cookies

| Setting | Default | Notes |
|---|---|---|
| `COOKIE_SECURE` | `true` when `NODE_ENV=production` | must be `true` for `SameSite=None` |
| `COOKIE_SAMESITE` | `strict` | `lax` if the admin console will ever be reached from another site |
| `COOKIE_DOMAIN` | empty (host-only) | set only if you need to share across subdomains |

Cookie paths: `access_token` → `/api/v1`, `refresh_token` → `/api/v1/auth`,
`csrf_token` → `/`.

The `csrf_token` cookie is intentionally **not** `httpOnly`: the browser must
read it to echo the value in the `X-CSRF-Token` header. It contains no identity
information and is only useful together with the ambient session cookie.

---

## 4. CSRF

`src/middleware/csrf.js` requires, for every `POST`/`PATCH`/`PUT`/`DELETE` that
authenticates via cookie:

```
X-CSRF-Token: <value of the csrf_token cookie>
```

Comparison is constant-time. Requests that authenticate **only** with
`Authorization: Bearer …` and send no session cookie are exempt: they are not
ambient-credential requests, so there is nothing for a third-party site to ride
on. `POST /auth/login` is exempt (it establishes the session) but is rate
limited.

A request with no credentials at all is passed through so that the auth layer
answers with a clear `401` rather than a misleading `403`.

---

## 5. Authorization

| Role | Capabilities |
|---|---|
| `owner` | everything, including `GET /audit-log` |
| `admin` | payment-method and payment-settings writes, all reads |
| `support` | all reads, no writes |

Enforced by `requireRole(...)` on each write route and re-checked against the
database row on every request (`authenticate` loads the admin and rejects
`status != 'active'`). Disabling an account takes effect on the next request.

---

## 6. SQL safety

- Every repository method in `src/db/mysql/repositories.js` binds values with
  `?` placeholders. Search terms are bound as `LIKE ?` patterns, never
  concatenated.
- The **only** strings interpolated into SQL are sort column names taken from a
  hard-coded whitelist (`SORT_COLUMNS`) with a fixed `ASC`/`DESC` suffix, both
  validated by the request schema before they reach the repository.
- Tests send `' OR 1=1 --`, `"; DROP TABLE users; --` and
  `%' UNION SELECT password_hash FROM admins --` as search terms and assert that
  they match nothing and that the table is intact (`tests/users.test.js`,
  `tests/withdrawals.test.js`).

---

## 7. Audit trail

`audit_log` records actor, action, entity, summary, before/after JSON, IP and
user agent for every administrative change.

`src/modules/audit/audit.service.js`:

1. `redact()` walks the payload and replaces any key matching the deny-list
   (`password*`, `*token*`, `secret*`, `authorization`, `cookie`, `api_key`,
   `private_key`, `mnemonic`, `seed_phrase`, `cvv`, `iban`, `card_number`, …)
   with `[REDACTED]`.
2. `assertSafeToAudit()` then throws if a deny-listed key is still present, so a
   developer cannot accidentally start logging a credential — the write fails
   loudly instead.

Passwords, tokens and credentials are **never** passed to the audit service in
the first place. Tests assert that no audit entry contains a password, token,
secret, cookie or authorization string.

---

## 8. Secrets and logging

- `src/config/env.js` fails startup when `JWT_ACCESS_SECRET` is missing or under
  32 characters. There is no default and no silent fallback.
- The structured logger (`src/lib/logger.js`) redacts `password`, `token`,
  `secret`, `authorization`, `cookie`, `api_key` etc. from any structured field,
  and never logs request or response bodies.
- `GET /health` returns process facts only. No hostnames, database names,
  versions, connection details or credentials.
- Error responses contain `code`, `message`, optional `details` and
  `request_id`. Stack traces are only written to the server log, and only when
  `NODE_ENV !== 'production'`.

---

## 9. Data minimisation

Deliberately **absent** from the schema and the API:

- identity documents / KYC uploads — `users.kyc_status` is a status label only;
- card numbers, CVV, IBAN, bank credentials;
- wallet addresses, private keys, seed phrases;
- payment-provider API keys;
- plaintext or reversible user passwords (this is an admin console; the only
  password hashes in the database are the administrators' own).

The application must not be extended to store any of the above without a
documented legal and PCI-DSS/AML review.

---

## 10. Security headers

`helmet` is applied with:

- `x-powered-by` disabled;
- `Referrer-Policy: no-referrer`;
- `Cross-Origin-Resource-Policy: same-site`;
- HSTS (`Strict-Transport-Security`, 1 year, `includeSubDomains`) in production;
- `Content-Security-Policy` is intentionally **not** set — this service returns
  JSON only; the CSP belongs on the page that serves the HTML.

CORS uses an explicit allow-list with `credentials: true`. A wildcard is
rejected by configuration validation, because a credentialed wildcard origin is
meaningless and dangerous.

---

## 11. Pre-deployment checklist

- [ ] `npm run check` reports valid configuration
- [ ] `npm test` green (both `memory` and, on a staging host, `mysql`)
- [ ] `JWT_ACCESS_SECRET` is unique to this environment and ≥ 32 characters
- [ ] `NODE_ENV=production`, `COOKIE_SECURE=true`
- [ ] `CORS_ALLOWED_ORIGINS` lists only the real admin-console origin(s)
- [ ] TLS terminated at the proxy, HTTP redirects to HTTPS, HSTS on
- [ ] MySQL user is least-privilege (`SELECT, INSERT, UPDATE, DELETE`)
- [ ] MySQL is not reachable from the internet (`bind-address=127.0.0.1`)
- [ ] Backups scheduled and a restore rehearsed
- [ ] `SEED_ALLOW_IN_PRODUCTION=false` (or unset)
- [ ] Process runs as a non-root user under a supervisor with `Restart=always`
- [ ] At least one administrator provisioned with `npm run admin:create`
