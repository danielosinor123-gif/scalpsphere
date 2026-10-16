# ScalpSphere Admin — Frontend

A zero-dependency, no-build admin console that connects to the existing
ScalpSphere admin backend. Vanilla HTML/CSS/JS, ScalpSphere dark-green branding,
responsive, accessible, and wired **only** to endpoints that actually exist.

The backend is the source of truth for every value on screen. Nothing here
stores records in the browser, invents figures, or fakes an action the API does
not perform.

---

## Run it

```bash
# terminal 1 — the backend
cd backend && npm run dev            # http://127.0.0.1:4000

# terminal 2 — the admin UI
cd frontend && node serve.mjs        # http://127.0.0.1:8080
```

Open **http://127.0.0.1:8080**. Sign in with an administrator account provisioned
via `npm run admin:create`.

`serve.mjs` is development tooling: it serves the static files and proxies
`/api/*` to the backend so both share one origin. That matters because the
backend's session cookies are `SameSite=Strict`, so a same-origin UI needs no
CORS or cookie configuration at all — and the backend needs **zero changes**.

In production you do not need `serve.mjs`: point nginx (or any web server) at
this directory and proxy `/api` to the backend — exactly the layout already
documented in `backend/docs/DEPLOYMENT_HOSTINGER.md` §3.8.

> **The pages must be served over HTTP(S).** Opened from `file://` they have an
> opaque origin, cannot hold the session cookies, and are refused by the API's
> CORS allow-list. That is by design, not a defect.

### Configuration

`assets/config.js` holds the only runtime setting: `apiBase`, which defaults to
`''` (same origin). **There is no hardcoded production domain.** If the API
lives elsewhere, change `apiBase` there — and add that origin to the backend's
`CORS_ALLOWED_ORIGINS`.

### Verify

```bash
node verify.mjs        # 124-check sweep: every page, asset, view and action
```

---

## Pages and the endpoints each one uses

| Page | Endpoints |
|---|---|
| **Login** (`login.html`) | `GET /auth/me` (redirect if already signed in) · `POST /auth/login` · `GET /health` (status dot) |
| **Dashboard** | `GET /dashboard/summary` · `GET /dashboard/activity?range=7d\|30d` |
| **Manage Users** | `GET /users` (search, status, KYC, sort, pagination) · `GET /users/facets` · `GET /users/:id` |
| **KYC Applications** | `GET /users/facets` · `GET /users?kyc_status=…` · `GET /users/:id` — read-only status view |
| **Manage Withdrawals** | `GET /withdrawals` (search, status, method, date range, sort, pagination) · `GET /withdrawals/facets` · `GET /withdrawals/:id` |
| **Administrators** | `GET /auth/me` · `POST /auth/change-password` · `POST /auth/logout-all` |
| **Settings → Payment Methods** | `GET /payment-methods` · `POST /payment-methods` · `PATCH /payment-methods/:id` · `POST /payment-methods/:id/enable\|disable` · `DELETE /payment-methods/:id` |
| **Settings → Payment Preferences** | `GET /payment-settings` · `GET /payment-settings/currencies` · `PUT /payment-settings` |
| **Audit Log** *(owner only)* | `GET /audit-log` (action, entity_type, pagination) |
| **About** | `GET /health` |

Every request goes through the single API client in `assets/api.js`, which
handles the envelope, cookies, the CSRF header on writes, one automatic refresh
on 401, and consistent error objects. No raw `fetch` is used anywhere else.

## Sections with no backend (shown as "Not available in this backend")

| Section | Why | Would require |
|---|---|---|
| Investment Plans | No plan catalogue, terms or subscriptions exist | `investment_plans` model + `GET /investment-plans` + pricing rules |
| Manage Deposits | No deposit records are modelled; only withdrawals exist | `deposits` table + `GET /deposits` + review semantics |
| Email Services | The backend deliberately sends no email | provider integration + template endpoints |
| Copy Trading | No trader/strategy/follower model | strategy model + fee/allocation rules |
| Bot Trading | No bot model or execution semantics | bot model + engine (out of backend scope) |
| Crypto Staking | No assets, durations or reward rules | staking model + reward rules |
| Stock Trading | No trading model; market feeds are out of scope | order model + market data (out of scope) |
| Crypto Trading | Same as stock trading | same |
| Manage Accounts | No account-type model beyond `users` | account types + `GET /accounts` |
| Tasks | No task model | `tasks` table + endpoints |
| Leads | No lead model | `leads` table + endpoints |

Each of these renders a panel that states the reason and lists the missing
endpoints — never sample data.

**One deliberate addition:** *Audit Log* is not in the original mockup's
navigation, but the backend implements `GET /audit-log` (owner only), so it is
included under System and marked with an "API" tag. Everything else follows the
mockup's section inventory.

## Deliberate UI limitations (matching backend reality)

- **Withdrawals are read-only.** The backend defines no approve/reject/process
  action, so no such buttons exist. `verify.mjs` proves the endpoints do not
  exist (404).
- **Users are read-only.** No balance-edit control, because the backend exposes
  no authorised user-write workflow.
- **KYC shows status labels only.** No documents exist in the backend, so none
  can be uploaded or viewed.
- **"Export CSV" explains itself instead of lying.** There is no export
  endpoint and the list is paginated, so emitting a partial file would be
  misleading; the button says so.
- **Administrators shows your session only.** The backend intentionally exposes
  no admin-listing endpoint.
- **Roles drive the UI, but the backend stays authoritative.** `support`
  sign-ins hide write controls and the Audit Log; `verify.mjs` proves the
  backend independently refuses those writes (403).

## Security properties

- Credentials only ever exist in httpOnly cookies; **no token, password or
  record is written to `localStorage`/`sessionStorage`**.
- Writes automatically carry `X-CSRF-Token` from the readable `csrf_token`
  cookie (the backend's double-submit scheme).
- Every value is rendered through `createElement`/`textContent` — no data is
  ever interpolated as HTML, so injected markup cannot execute.
- Errors surface the server's `code`/`message`/`request_id` only; no stack
  traces, no secrets, no raw database errors.
- 401 triggers one silent refresh, then a redirect to the login page; 403 shows
  a permission-denied state rather than a generic failure.
- No success toast is ever shown before the server confirms the action.

## Files

```
frontend/
  index.html            app shell (sidebar, top bar, view container)
  login.html            sign-in page
  serve.mjs             dev server: static files + same-origin /api proxy
  verify.mjs            124-check verification sweep
  assets/
    config.js           runtime config (apiBase — no hardcoded domain)
    api.js              the only network layer
    ui.js               safe DOM builder, states, tables, dialogs, toasts
    app.js              router + every section view
    login.js            login controller
    styles.css          ScalpSphere dark-green design system
```
