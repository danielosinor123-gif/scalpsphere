# StakeClone

A two-part project: a **Node.js + Express + MySQL admin backend** and a
**zero-dependency admin frontend**, sharing one database and one source of
truth. All records in a fresh install are clearly-labelled synthetic demo
fixtures — no live financial integrations, market feeds, or payment providers.

```
backend/    REST API  — /api/v1  (admin + customer portal, MySQL)
frontend/   Admin UI  — vanilla HTML/CSS/JS, no build step
```

## Quick start

```bash
# 1. Backend
cd backend
cp .env.example .env          # fill it in — see backend/docs/SETUP.md
npm install
npm run migrate              # creates the schema
npm run admin:create         # the ONLY way an admin account exists
npm run dev                  # API on http://127.0.0.1:4000

# 2. Admin UI (separate terminal)
cd frontend
node serve.mjs               # UI + API proxy on http://127.0.0.1:8080
```

Sign in at `http://127.0.0.1:8080` with the administrator you provisioned.

## Tests

```bash
cd backend
npm test                     # 122 checks, no database required
npm run test:mysql           # the same suite against a real MySQL/MariaDB schema
cd frontend && node verify.mjs   # 124 checks: every page, view and action
```

## Documentation

| Document | Contents |
|---|---|
| [`backend/README.md`](backend/README.md) | Backend overview, verification status, quick start |
| [`backend/docs/SETUP.md`](backend/docs/SETUP.md) | Local setup, migrations, seeding, provisioning, tests |
| [`backend/docs/API_CONTRACT.md`](backend/docs/API_CONTRACT.md) | Admin API: every route, field, status code |
| [`backend/docs/CUSTOMER_API.md`](backend/docs/CUSTOMER_API.md) | Customer portal API + token-domain separation |
| [`backend/openapi.yaml`](backend/openapi.yaml) | Machine-readable API specification |
| [`backend/docs/SECURITY.md`](backend/docs/SECURITY.md) | Auth, CSRF, rate limiting, audit trail, data rules |
| [`backend/docs/TESTING.md`](backend/docs/TESTING.md) | Test modes and what the suite proves |
| [`backend/docs/CAPACITY.md`](backend/docs/CAPACITY.md) | Measured throughput and sizing |
| [`backend/docs/DEPLOYMENT_HOSTINGER.md`](backend/docs/DEPLOYMENT_HOSTINGER.md) | Hostinger/production deployment |
| [`frontend/README.md`](frontend/README.md) | Admin UI: pages, endpoints, limitations |

## Scope notes

The admin UI implements only the sections the backend supports (Dashboard,
Users, KYC status, Withdrawals, Administrators, Settings, Audit Log). Sections
with no backend — Investment Plans, Deposits, Email, Trading, Staking, Tasks,
Leads and similar — render an explicit "Not available in this backend" state
naming what would be required, never sample data.
