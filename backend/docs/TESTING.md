# Testing Guide

Two test modes, one test suite, plus a full-stack smoke script. `docs/SETUP.md`
§3 has the commands; this file explains what the suite proves and how it is
built.

---

## 0. Verified against a real database

The MySQL path is not theoretical. It was executed end to end against a real
server:

| Run | Result |
|---|---|
| `npm run migrate` against MariaDB 11.4.5 | 1 migration applied, all 10 tables created with `utf8mb4_0900_ai_ci` |
| `npm run test:mysql` (MariaDB 11.4.5) | **90 / 90 pass** |
| `npm run smoke:db` (MariaDB 11.4.5) | **38 / 38 pass** |
| `npm test` (offline mode, no DB) | **90 / 90 pass** |
| Live dev server (`node scripts/verify-dev-server.mjs`) | **22 / 22 pass** |

Doing that surfaced **four product bugs and three harness bugs** that the offline
mode could not catch. All are fixed and regression-tested.

### Product bugs

1. **`CAST(? AS JSON)` is MySQL-8-only syntax.** MariaDB rejects it, so every
   audited write failed with a 500. The insert now binds a JSON-encoded *string*
   and lets the column parse it, which both servers accept. Notably, the API
   still returned a clean generic 500 to the client — the error handler worked
   exactly as designed, so the failure was only visible server-side.
2. **`ref_sequences` produced `PAY-00000` on the first insert, then skipped a
   number.** `LAST_INSERT_ID()` is not set on the fresh-INSERT path when the
   table has no `AUTO_INCREMENT` column. Fixed by making the sequence column
   `AUTO_INCREMENT`, which sets it on both paths.
3. **A `UNIQUE` key on the sequence column made the increment collide.** All
   prefixes share one sequence, so bumping `USR` from 1 to 2 collided with
   whatever prefix already owned 2. The key is now a plain non-unique index —
   an `AUTO_INCREMENT` column still has to be a key, and a plain index satisfies
   that without forbidding shared increments.
4. **JSON columns come back as strings from MySQL.** `audit_log.before_json` /
   `after_json` arrived as text, so audit diffs were strings rather than
   objects. The repository normalises them, so both drivers return the same
   shape.

### Harness bugs

5. **`DB_DRIVER=mysql` was hard-overridden to `memory`** by the test bootstrap,
   so the documented `DB_DRIVER=mysql npm test` silently did nothing. It now
   honours an explicit value.
6. **`config.test.js` leaked its parent environment into the child process** —
   twice, in two different ways: first from the shell, then from the
   repository's own `.env` via dotenv. The child env is now built from a minimal
   allow-list *and* `DOTENV_CONFIG_PATH` points at a nonexistent file, so the
   suite stays hermetic even when a valid `.env` exists.
7. **The `smoke:db` safety guard ran *after* the destructive step.** The guard
   refused to touch any schema not named `*test*`, but it was evaluated after
   the seed had already truncated the target — so it protected nothing. It is
   now the first thing the script does. This was found the hard way: a
   mis-aimed smoke run wiped the development schema's `admins` table. The data
   was synthetic demo fixtures and was re-provisioned, but the ordering bug was
   real and is the reason the guard now runs before any child process is
   spawned.

---

## 1. Modes

| Mode | `DB_DRIVER` | `NODE_ENV` | Requires a MySQL server? |
|---|---|---|---|
| Offline (default) | `memory` | `test` | **No** |
| Real database | `mysql` | `test` | Yes — a disposable `scalpsphere_test` schema |

The mode changes only **which repository implementation** is injected. The
Express app, the routes, the validation, the serializers and every assertion are
identical.

### Why an in-process driver at all?

`config/env.js` refuses `DB_DRIVER=memory` unless `NODE_ENV=test`, because an
in-process store is not durable and must never be used in production. It exists
so the suite can run anywhere — laptops, CI containers, locked-down build agents
— with zero external services, while still testing the real HTTP contract.

Both drivers enforce the same rules:

- the same unique, foreign-key, check and enum constraints
  (`src/db/memory/repositories.js` mirrors `migrations/001_schema.sql`);
- the same short public references (`USR-00001`, `WDR-00001`, `PAY-00001`);
- the same unit-of-work semantics (commit/rollback), verified by an explicit
  rollback test that asserts a failed write is invisible afterwards.

**MySQL mode must run serially.** Node's test runner executes test *files* in
parallel by default, which is fine against a per-process in-memory store but
would make nine files fight over one shared schema. `npm run test:mysql` passes
`--test-concurrency=1`; keep that flag if you invoke the runner by hand.

---

## 2. `npm run smoke:db` — the operational path

The unit suite proves the HTTP contract. `scripts/smoke-test.js` proves the
**whole operational story** against a real database, including the CLI tools:

1. `scripts/seed-demo.js --reset --yes` — wipe and re-seed demo fixtures;
2. `scripts/create-admin.js` — the out-of-band administrator provisioning path;
3. the real HTTP API — login, dashboard (all four cards with their live/demo
   provenance), users, withdrawals, payment-method create/update/disable/delete,
   a case-insensitive duplicate rejection (409), settings with currency
   conversion, the audit log, and auth failures.

It asserts 38 checks, including things the unit suite cannot see end to end:
that the seeded `Litecoin` duplicate is collapsed to one row, that the selected
currency (₦) propagates from settings into every money display field, that
`total_users` is rendered without a currency symbol, and that no credentials
appear anywhere in the audit trail.

**It wipes the target schema.** Point it at a throwaway database.

---

## 3. What the unit suite proves

### `health.test.js`
- `200` without authentication and the documented shape.
- `X-Request-Id` correlation header.
- No hostnames, database names, secrets or framework versions leak.
- Unknown routes do not disclose the route list to anonymous callers.

### `auth.test.js`
- Login sets httpOnly cookies and returns an access token + CSRF token.
- `401 INVALID_CREDENTIALS` is identical for unknown account and wrong password.
- Malformed email and unknown fields → `422` with `details[].field`.
- Tampered token → `401`.
- Cookie-authenticated writes without `X-CSRF-Token` → `403`.
- `/auth/me`, logout, and refresh rotation (old refresh token is refused).
- Password policy rejection; wrong current password → `400`.
- No response body ever contains a bcrypt hash.

### `auth-rate-limit.test.js`
- Successful logins do not count toward the limit.
- The Nth failed attempt returns `423 ACCOUNT_LOCKED` and blocks even correct
  credentials until the lockout elapses.
- Failed-login audit entries contain no password or token.

### `dashboard.test.js`
- Exactly the four `admin.html` cards, in order, with `source` and `is_demo`.
- `total_users` and `pending_withdrawals` move when live rows are inserted.
- `total_deposits` and `active_investments` are flagged `is_demo: true`.
- Panel payloads, `activity` 7/30-point series with gap filling, bounded
  `recent-users` limit.

### `users.test.js`
- Pagination metadata (`page`, `per_page`, `total`, `total_pages`, `has_next`,
  `has_prev`).
- Minor units **and** the HTML display string, with a currency-aware assertion.
- Seeded rows are labelled `is_demo: true`.
- Search across name/email/reference.
- **SQL injection payloads match nothing and leave the table intact.**
- `status`/`kyc_status` filters, sort whitelist enforcement.
- `page=0`, `per_page=500`, `page=abc` → `422`.
- Facets derived from the live table.
- `404` for an unknown reference; detail includes recent withdrawals.
- No `POST/PUT/PATCH/DELETE` on `/users`.

### `withdrawals.test.js`
- Pagination and column names matching the HTML table.
- Search across client / method / receiver email; injection payloads are literal.
- `status` filter, `method` filter, `from`/`to` validation (`from <= to`).
- Facets report the pending queue behind the dashboard card.
- `404` for an unknown id.
- **No mutation endpoints exist** (`/approve`, `/process`, etc.).

### `paymentMethods.test.js`
- Seeding, pagination, and the `crypto|currency` × `deposit|withdraw|both`
  vocabulary from the HTML.
- Create validation for every field, including unknown-field rejection.
- `409 CONFLICT` on a case-insensitive duplicate name.
- Blocked with `401` when unauthenticated and `403` when the CSRF header is
  missing — and nothing is written in either case.
- Update, enable, disable, delete — each audited with a correct before/after
  diff.
- `support` role can read but gets `403` on writes.
- The audit log is paginated and never contains a credential.

### `settings-security.test.js`
- Defaults equal the HTML form (`USD`, `automatic`, `$10.00`, `$10.00`).
- `PUT` replaces everything and normalises amounts into minor units, honouring
  the selected currency's symbol.
- `PATCH` changes only supplied fields.
- Invalid currency / mode / malformed amount / absurd amount → `422` or `400`.
- A failing transaction rolls back and the rolled-back row is invisible (the
  test joins the repository to the caller's transaction connection, which is
  the documented way to compose multi-statement writes).
- Oversized bodies → `413`.
- An allow-listed origin is echoed; an unlisted origin is `403` and gets no
  `Access-Control-Allow-Origin`.
- No response body contains the configured `JWT_ACCESS_SECRET`.
- Error payloads contain no stack traces, SQL text or driver codes.

### `config.test.js`
- Valid configuration passes.
- Missing / too-short `JWT_ACCESS_SECRET` → refuses.
- Production without `CORS_ALLOWED_ORIGINS` → refuses.
- Wildcard CORS → refused in every environment.
- `DB_DRIVER=memory` outside test → refused; inside test → allowed.
- Production without `DB_PASSWORD` → refused.
- Production with `BCRYPT_ROUNDS < 10` → refused.
- `COOKIE_SAMESITE=none` without `COOKIE_SECURE=true` → refused.
- Out-of-range `PORT` → refused.

---

## 4. How the tests are wired

```js
const ctx = await createTestContext();   // tests/helpers/context.js
```

`createTestContext()`:

1. `applyTestEnv()` writes the full test configuration into `process.env`
   **before** any `src/` module is imported (Node gives each test file its own
   process, and ESM import order guarantees the helper runs first). It defaults
   `DB_DRIVER` to `memory` but honours an explicit `DB_DRIVER=mysql`.
2. Dynamically imports `src/app.js` so `src/config/env.js` sees the test env.
3. `createDatabase()` → whichever driver was selected.
4. Against MySQL, truncates every application table so each serially-run file
   starts from an empty schema (the memory driver is already per-process).
5. `createApp({ db })` → the real Express application.
6. `app.listen(0)` → an ephemeral port, closed in `after()`.

The HTTP client is a small `fetch` wrapper with a cookie jar, so cookie-based
authentication and the double-submit CSRF pattern are exercised exactly as a
browser would use them. `withCsrf()` automatically attaches the `X-CSRF-Token`
header from the jar.

Each file can override configuration before the app is built — that is how
`auth-rate-limit.test.js` runs with `RATE_LIMIT_LOGIN_MAX=3` without affecting
any other file.

---

## 5. Writing a new test

```js
import { test, before, after } from 'node:test';
import { createTestContext } from './helpers/context.js';

let ctx;
before(async () => { ctx = await createTestContext(); });
after(async () => { await ctx.close(); });

test('example', async () => {
  const res = await ctx.client.get('/api/v1/users?per_page=5');
  assert.equal(res.status, 200);
});
```

Seed fixtures through the repositories, never through the HTTP API, unless the
API call itself is what you are testing:

```js
await seedPaymentMethod(ctx, { name: 'Test Coin', type: 'crypto', usedFor: 'both' });
```

Rules for new tests:
- assert the **status code**, the `success` flag, and the documented field names;
- never assert on an exact timestamp;
- keep admin password fixtures ≥ 12 chars with mixed classes (the policy is
  enforced);
- if you need a different limit, pass overrides to `createTestContext({...})`.
