# Setup & Operations Guide

Everything below runs from the `backend/` directory.

---

## 1. Prerequisites

| Requirement | Version | Check |
|---|---|---|
| Node.js | ≥ 20.12 (LTS 22 recommended) | `node --version` |
| npm | ≥ 10 | `npm --version` |
| MySQL or MariaDB | 8.0+ / 10.6+ | `mysql --version` |

You need a MySQL user that can create a schema (for migrations) and, at runtime,
only `SELECT/INSERT/UPDATE/DELETE` on the application tables.

```sql
CREATE DATABASE scalpsphere
  CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;

CREATE USER 'scalpsphere_app'@'localhost' IDENTIFIED BY '<strong-password>';
GRANT SELECT, INSERT, UPDATE, DELETE ON scalpsphere.* TO 'scalpsphere_app'@'localhost';
FLUSH PRIVILEGES;
```

---

## 2. Local development

### 2.1 Install

```bash
cd backend
npm install
```

### 2.2 Configure

```bash
cp .env.example .env
```

Edit `.env`. The minimum you must change for local use:

```ini
NODE_ENV=development
DB_DRIVER=mysql
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=scalpsphere_app
DB_PASSWORD=<your-password>
DB_NAME=scalpsphere
JWT_ACCESS_SECRET=<generate — see below>
```

Generate a secret:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

Never commit `.env`. `.env.example` deliberately contains no real secret.

#### Two database users, not one

The runtime account (`DB_USER`) is granted **only** `SELECT, INSERT, UPDATE,
DELETE`, so a compromised application cannot alter the schema. Migrations need
DDL, so `npm run migrate` connects as a separate, more privileged account:

```ini
DB_MIGRATION_USER=scalpsphere_migrate
DB_MIGRATION_PASSWORD=<only used by npm run migrate>
```

Grant them like this:

```sql
CREATE USER 'scalpsphere_app'@'localhost' IDENTIFIED BY '<dml-password>';
GRANT SELECT, INSERT, UPDATE, DELETE ON scalpsphere.* TO 'scalpsphere_app'@'localhost';

CREATE USER 'scalpsphere_migrate'@'localhost' IDENTIFIED BY '<ddl-password>';
GRANT ALL PRIVILEGES ON scalpsphere.* TO 'scalpsphere_migrate'@'localhost';
```

If `DB_MIGRATION_USER` is not set, `npm run migrate` falls back to
`DB_USER`/`DB_PASSWORD` (and will fail with `CREATE command denied` if that
account really is least-privilege — which is the correct outcome). In
production, pass the migration credentials on the command line rather than
storing them in a file.

#### Automating the local setup

`scripts/setup-local-db.mjs` does all of the above against a local server on
`127.0.0.1:3306` (as `root`): creates the `scalpsphere` and `scalpsphere_test`
schemas, creates both least-privilege users with generated passwords, verifies
the app user really cannot create tables, and writes `.env`. Credentials are
generated with `crypto.randomBytes` and never printed.

```bash
ROOT_DB_PASSWORD=<root password> node scripts/setup-local-db.mjs
```

### 2.3 Validate configuration

```bash
npm run check
```

Output is either `configuration is valid` plus a summary, or a single message
listing **every** problem it found. The server itself runs the same validation
and exits with status `2` if anything is missing — there is no insecure fallback.

### 2.4 Create the schema

```bash
npm run migrate
```

This applies `migrations/*.sql` in filename order and records each file's
SHA-256 checksum in `schema_migrations`. A file that is edited after being
applied is **refused**, so you must add a new migration instead.

```bash
npm run migrate:status     # show applied vs available migrations
```

### 2.5 Provision the first administrator

There is **no** default admin password and **no** public registration endpoint.

```bash
npm run admin:create
```

Roles: `owner` (everything, including the audit log), `admin` (payment
configuration), `support` (read-only).

Other admin commands:

```bash
npm run admin:set-password -- --email ops@example.com     # resets + revokes sessions
npm run admin:revoke-sessions -- --email ops@example.com --reason "device lost"
```

### 2.6 Provision customer portal access

Customers are a **separate token domain** from administrators (see
[`CUSTOMER_API.md`](./CUSTOMER_API.md) §2). There is no public sign-up endpoint —
whether self-service registration is a requirement is an open business decision.
An operator attaches a portal password to a user that already exists in the
admin-managed `users` table:

```bash
CUSTOMER_PASSWORD="$(openssl rand -base64 18)" \
  npm run customer:credentials -- --email someone@example.com
```

The CLI refuses if no such `users` row exists — identity is created in the
admin panel, never by the portal. For local development, `npm run seed` gives
the demo users a shared synthetic password (printed by the command) so the
portal is usable immediately.

### 2.7 Seed demo fixtures (optional, intentional only)

```bash
npm run seed          # refuses if the tables are non-empty
npm run seed:reset    # wipe, then seed
npm run seed -- --yes # skip the confirmation prompt (CI)
```

Guards:
- Requires typing `demo` at the prompt (or `--yes`).
- Refuses to run when `NODE_ENV=production` unless
  `SEED_ALLOW_IN_PRODUCTION=true`.
- Every created row is flagged `is_demo = 1`.
- **Never creates an administrator.**
- No identity documents, card details, wallet keys or credentials are written.

### 2.8 Run the API

```bash
npm run dev    # node --watch, restarts on change
npm start      # production entry point
```

```bash
curl http://localhost:4000/api/v1/health
```

### 2.9 Typical order

```bash
npm install && cp .env.example .env   # then edit .env
npm run check
npm run migrate
npm run admin:create
npm run customer:credentials -- --email someone@example.com   # optional
npm run dev
```

Or, if a local MariaDB/MySQL is already running on `127.0.0.1:3306`:

```bash
npm install
ROOT_DB_PASSWORD=<root password> node scripts/setup-local-db.mjs
npm run migrate
npm run seed -- --yes
npm run admin:create
npm run customer:credentials -- --email trayson.white@example.com
npm run dev
```

### 2.10 Keeping the API running on Windows

`npm run dev` is a foreground process tied to the terminal that started it. To
run it persistently on a Windows machine there are two options.

#### Detached (simplest, no extra software)

```powershell
# start — survives the shell that launched it
powershell -ExecutionPolicy Bypass -File scripts\start-dev.ps1

# stop
powershell -ExecutionPolicy Bypass -File scripts\stop-dev.ps1
```

Logs go to `backend/logs/dev-server.log`. This does **not** survive a reboot.

#### As a real Windows service (survives reboots and crashes)

Use [NSSM](https://nssm.cc/) — the Windows equivalent of systemd:

```powershell
choco install nssm          # or download nssm.exe directly

nssm install ScalpSphereAPI "C:\Program Files\nodejs\node.exe" "src\server.js"
nssm set ScalpSphereAPI AppDirectory "C:\path\to\backend"
nssm set ScalpSphereAPI AppEnvironmentExtra "NODE_ENV=production"
nssm set ScalpSphereAPI AppStdout "C:\path\to\backend\logs\service.log"
nssm set ScalpSphereAPI AppStderr "C:\path\to\backend\logs\service.err.log"
nssm set ScalpSphereAPI AppRotateFiles 1
nssm set ScalpSphereAPI Start SERVICE_AUTO_START
nssm set ScalpSphereAPI AppExit Default Restart
nssm set ScalpSphereAPI AppRestartDelay 2000
nssm start ScalpSphereAPI
```

`AppExit Default Restart` + `AppRestartDelay 2000` give the same crash-recovery
behaviour as the systemd unit in
[`DEPLOYMENT_HOSTINGER.md`](./DEPLOYMENT_HOSTINGER.md) §3.6.

> The production target for Hostinger is a **Linux VPS with systemd**, which is
> what the deployment guide covers in full. The Windows service above is for
> running the API persistently on a workstation — for frontend integration work,
> or if Windows is genuinely your host.

---

## 3. Running the tests

### 3.1 Offline suite (no database required)

```bash
npm test
```

Runs 90 assertions across 9 files with the Node.js built-in test runner. The
default mode sets `NODE_ENV=test` and `DB_DRIVER=memory`, which selects an
in-process implementation of the exact same repository contract used by MySQL.
That means the HTTP layer, authentication, CSRF, validation, pagination, audit
logging and **transaction rollback** are all exercised end to end without any
external service.

The suite needs no network access and no MySQL server, so it runs in CI on any
machine.

### 3.2 The same suite against a real MySQL / MariaDB test database

```bash
# 1. Create a disposable schema (never point this at production data)
mysql -u root -p -e "CREATE DATABASE scalpsphere_test CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;"
mysql -u root -p -e "GRANT ALL PRIVILEGES ON scalpsphere_test.* TO 'scalpsphere_app'@'localhost'; FLUSH PRIVILEGES;"

# 2. Apply the schema
DB_NAME=scalpsphere_test JWT_ACCESS_SECRET='test-only-secret-value-with-enough-entropy-0123456789' \
  npm run migrate

# 3. Run the identical test files against MySQL (serially — see the note below)
DB_DRIVER=mysql DB_NAME=scalpsphere_test \
JWT_ACCESS_SECRET='test-only-secret-value-with-enough-entropy-0123456789' \
BCRYPT_ROUNDS=4 COOKIE_SECURE=false LOG_LEVEL=error \
  npm run test:mysql
```

Notes:
- `npm run test:mysql` sets `DB_DRIVER=mysql` and passes `--test-concurrency=1`.
  The serial flag matters: Node runs test *files* in parallel by default, which
  is fine against a per-process in-memory store but would make nine files fight
  over one shared schema. Each file truncates the application tables on startup
  so it begins from a clean state.
- MariaDB works too. The whole path has been verified against MariaDB 11.4.
  See `docs/TESTING.md` §0 for the compatibility notes and the bugs that the
  real-database run caught.
- Production data is never touched: the test database name is separate,
  `DB_DRIVER=memory` is refused outside `NODE_ENV=test`, and
  `scripts/seed-demo.js` refuses to seed into a production `NODE_ENV`.
- Reset between runs with
  `mysql -e "DROP DATABASE scalpsphere_test; CREATE DATABASE scalpsphere_test CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;"`
  followed by `npm run migrate`.

### 3.3 Full-stack smoke test (`npm run smoke:db`)

Runs the complete operational path against a real database — the CLI tools, not
just the HTTP API:

```bash
DB_DRIVER=mysql DB_NAME=scalpsphere_test \
JWT_ACCESS_SECRET='test-only-secret-value-with-enough-entropy-0123456789' \
BCRYPT_ROUNDS=4 LOG_LEVEL=error \
  npm run smoke:db
```

It wipes the target schema, then runs `seed-demo --reset --yes`, `create-admin`,
and drives the live API through login, dashboard, users, withdrawals,
payment-method CRUD, settings, the audit log and auth failures — 38 checks.

**It deletes data.** Two protections are built in:

- it **refuses to run** unless `DB_NAME` contains `test`, so a `.env` pointing at
  the development or production database cannot be destroyed by accident;
- the refusal happens **before** any child process is spawned — the guard is the
  first thing the script does, not an afterthought.

### 3.4 Verifying a running dev server

```bash
npm run dev      # in one terminal
node scripts/verify-dev-server.mjs   # in another
```

`scripts/verify-dev-server.mjs` hits the live server on
`http://127.0.0.1:4000` with the local admin account and checks 22 things:
health, login, all four dashboard cards, the seeded demo rows
(Trayson Abraham White / `$450.00`, CHAN LYE KLUAN / `$537.00` / pending),
search, the collapsed `Litecoin` duplicate, payment-method create/delete, the
settings defaults, and that the audit log contains no credentials. It is a
read-mostly smoke check for a developer who wants to confirm their running
instance, and needs `scripts/setup-local-db.mjs` + `npm run seed` +
`npm run admin:create` to have been run first.

### 3.5 What is covered

| Area | File |
|---|---|
| Health, 404/405 handling, no leakage | `tests/health.test.js` |
| Login, refresh rotation, logout, lockout, CSRF, password policy | `tests/auth.test.js` |
| Login rate limiting + failed-login auditing | `tests/auth-rate-limit.test.js` |
| Account lockout (limiter raised out of the way) | `tests/auth-lockout.test.js` |
| Dashboard cards, demo provenance, activity series | `tests/dashboard.test.js` |
| Users pagination, search, filters, sorting, injection safety | `tests/users.test.js` |
| Withdrawals pagination, search, filters, detail, no mutations | `tests/withdrawals.test.js` |
| Payment-methods CRUD, roles, conflicts, audit trail | `tests/paymentMethods.test.js` |
| Settings, money parsing, rollback, error envelopes, CORS | `tests/settings-security.test.js` |
| Fail-fast configuration validation (hermetic) | `tests/config.test.js` |
| **Customer auth, token-domain separation, lockout, CSRF** | `tests/customer-auth.test.js` |
| **Customer isolation, read-only financials, admin/customer consistency** | `tests/customer-data.test.js` |
| Seed → admin provision → live API (CLI + HTTP) | `scripts/smoke-test.js` |
| A running dev server, read-mostly | `scripts/verify-dev-server.mjs` |
| **The running customer portal, live** | `scripts/verify-customer-server.mjs` |

---

## 4. Production configuration

See [`DEPLOYMENT_HOSTINGER.md`](./DEPLOYMENT_HOSTINGER.md) for hosting specifics.
At minimum:

```ini
NODE_ENV=production
API_ORIGIN=https://api.your-domain.example
CORS_ALLOWED_ORIGINS=https://admin.your-domain.example
TRUST_PROXY=true              # behind Nginx/Apache; a number = hop count
DB_DRIVER=mysql
DB_HOST=127.0.0.1
DB_PASSWORD=<dedicated, least-privileged user>
DB_NAME=scalpsphere
JWT_ACCESS_SECRET=<48+ random bytes, base64url>
COOKIE_SECURE=true
COOKIE_SAMESITE=strict
LOG_LEVEL=info
LOG_FORMAT=json
SEED_ALLOW_IN_PRODUCTION=false
```

Hard rules enforced at startup:
- `JWT_ACCESS_SECRET` present and ≥ 32 characters.
- `CORS_ALLOWED_ORIGINS` non-empty and never `*` when `NODE_ENV=production`.
- `DB_PASSWORD` set in production.
- `BCRYPT_ROUNDS` ≥ 10 in production.
- `DB_DRIVER=memory` refused in production (it is not durable).
- `COOKIE_SAMESITE=none` requires `COOKIE_SECURE=true`.

Run as a dedicated non-root user, behind a reverse proxy that terminates TLS,
with the process supervised (systemd `Restart=always`). See the deployment guide
for complete unit files and Nginx configuration.

---

## 5. Backups and maintenance

```bash
# Logical backup (no locks, consistent snapshot on InnoDB)
mysqldump --single-transaction --routines --triggers \
  -u root -p scalpsphere | gzip > backups/scalpsphere-$(date +%F).sql.gz

# Restore into an empty schema
gunzip < backups/scalpsphere-2026-10-14.sql.gz | mysql -u root -p scalpsphere
```

Retain at least 7 daily + 4 weekly copies, store at least one off-host, and
**test a restore** before you need it.

`admin_sessions` can grow; expired rows are harmless but can be pruned:

```sql
DELETE FROM admin_sessions WHERE expires_at < UTC_TIMESTAMP();
```

---

## 6. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `STARTUP FAILED … JWT_ACCESS_SECRET` | Generate the secret and put it in `.env` |
| `ECONNREFUSED` on boot | MySQL not running, or `DB_HOST`/`DB_PORT` wrong |
| `ER_ACCESS_DENIED_ERROR` | Wrong `DB_USER`/`DB_PASSWORD`, or user lacks privileges |
| `DB_DRIVER=memory is not permitted` | `NODE_ENV` is not `test`; set `DB_DRIVER=mysql` |
| `403 CSRF_TOKEN_INVALID` on writes | Send `X-CSRF-Token` with the value from the `csrf_token` cookie (or login response) and `credentials: 'include'` |
| `401 UNAUTHENTICATED` after 15 minutes | Access token expired — call `POST /auth/refresh` |
| `423 ACCOUNT_LOCKED` | Too many failed logins; wait `LOGIN_LOCKOUT_MINUTES` or run `npm run admin:set-password` |
| `CREATE command denied to user 'scalpsphere_app'` during `npm run migrate` | Expected if the runtime user is least-privilege — set `DB_MIGRATION_USER`/`DB_MIGRATION_PASSWORD` (§2.2) |
| `REFUSING TO RUN … DB_NAME is "scalpsphere"` | `smoke:db` deliberately refuses to touch any schema whose name does not contain `test` |
| `Origin is not allowed by CORS policy` | Add the browser's exact origin (scheme + host + port) to `CORS_ALLOWED_ORIGINS` |
| Migration "modified after it was applied" | Restore the original file or write a new migration |

Enable `LOG_LEVEL=debug` and `LOG_FORMAT=pretty` temporarily for verbose,
structured (never credential-containing) logs.
