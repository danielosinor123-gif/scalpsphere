# ScalpSphere Admin — Backend

Node.js + Express + MySQL REST API that backs the two supplied static pages
(`index.html`, `admin.html`). **The frontend is not wired up yet** — this task
delivers the backend, its API contract, and an automated test suite.

> Both supplied HTML files are **untouched**. They are treated as read-only
> reference material describing the intended workflow and demo content.

---

## 1. What the existing files actually contain

### 1.1 `index.html` — public marketing page (72 lines, ~31 KB)

* A single-file, dark-themed **static landing page**. No forms, no `fetch`/XHR,
  no submission handlers, no `localStorage`, no auth hooks.
* Copy: "Wealth building, engineered with discipline."
* Sections: hero, Platform (6 feature cards), Markets, two feature rows,
  Security, How-it-works (4 steps), Global perspective, FAQ (5 items), CTA,
  footer.
* **Demo numbers (explicitly disclaimer-labelled in the file itself)**:
  * Hero metrics: `2,547+` active investors, `$318M+` assets monitored,
    `99.82%` platform availability, `95+` markets covered — followed by
    "Illustrative interface and sample metrics for demonstration purposes."
  * Market dashboard card: balance `$84,250.68`, `↗ 4.28%`, plus a hardcoded
    SVG chart and 1D/1W/1M/3M/1Y/ALL `chartSets` array.
  * Watchlist (hardcoded): BTC `$67,420.18 +2.84%`, ETH `$3,482.60 +1.67%`,
    AAPL `$213.07 +0.92%`, NVDA `$142.81 +3.18%`, XAU `$2,684.30 +0.41%`.
  * A `Live*` badge footnoted with `*Demo UI; no live market feed is connected.`
* Only JavaScript behaviour: mobile menu toggle, FAQ accordion, chart period
  switching, and a CTA button that shows the toast
  **"This is a demo button — backend functionality is not connected."**
* **Conclusion: there is nothing on the public page to build a backend for.**
  It is a visual recreation. No API endpoints are exposed for it.

### 1.2 `admin.html` — admin dashboard SPA in one file (72 lines, ~24 KB)

Client-side router over 17 sidebar items. Exactly **four** pages have real
content; the remaining 13 render the same `genericPage()` placeholder.

* **Dashboard** — the four stat cards the backend must reproduce:

  | Card | Demo value | Sub-label |
  |---|---|---|
  | Total users | `1,284` | `+8.2% this month` |
  | Total deposits | `$84,290` | `+12.4% this month` |
  | Pending withdrawals | `$1,247` | `3 requests awaiting` |
  | Active investments | `426` | `+5.7% this month` |

  plus a *Platform activity* chart ("Deposits and withdrawals · last 7 days",
  Mon–Sun, y-axis `$0–$8k`, two hardcoded SVG paths), a *Recent withdrawals*
  list (3 rows) and a *Recently registered users* table (4 rows).

* **Manage Users** — `users[]` array, 5 demo records with fields
  `id, name, email, balance, status (Active|Inactive), kyc (Verified|Pending), date`.
  Demo rows: 51 Trayson Abraham White `$450.00` Active/Verified; 46 CHAN LYE
  KLUAN `$537.00` Active/Verified; 41 Cryptostats2020 `$10.00` Active/Pending;
  40 Lynn Wright `$10.00` Inactive/Pending; 38 M. Wright `$1,250.00`
  Active/Verified.
  Table columns: ID, Client (name + email), Account balance, Status, KYC,
  Date created, Option.
  Tools: search box, Copy / CSV / Print, Previous/Next (non-functional beyond
  `alert`), and a per-row "View" button that only alerts.

* **Manage clients withdrawals** — `withdrawals[]` array, 3 demo records with
  fields `id, name, amount, fee, method, email, status (Pending|Processed), date`.
  Demo rows: 46 CHAN LYE KLUAN 537/537 USDT Pending; 41 Cryptostats2020 10/10
  Ethereum Processed; 40 Lynn Wright 10/10 Ethereum Processed.
  Table columns: ID, Client name, Amount requested, Amount charges, Payment
  Method, Receiver's email, Status, Date created, Option.

* **Payment Settings** — five tabs: `Payment Methods`, `Payment Preference`,
  `Coinpayment`, `Gateways`, `Transfer`. Only *Payment Methods* renders a table
  fed by the `methods[]` array of 22 demo entries
  (`[name, type ('crypto'|'currency'), used_for ('both'|'deposit'|'withdraw')]`
  — note **Litecoin is duplicated**), with an every-4th-row
  Enabled/Disabled pill, a `•••` toggle and a Delete button.
  **The other four tabs all render the same one "Payment Preference" form**:
  * Default currency — `USD — US Dollar` / `NGN — Nigerian Naira` / `EUR — Euro`
  * Payment processing mode — `Automatic` / `Manual review`
  * Payment instructions — free text
  * Minimum deposit — `10.00`
  * Minimum withdrawal — `10.00`
  * "Save changes" → `alert('Demo settings saved locally for this session.')`

* **The other 13 nav items** (Investment, Manage Deposits, Email Services,
  KYC Application(s), Copy Trading, Bot Trading, Crypto Staking, Stock
  Trading, Crypto Trading, Manage Accounts, Task, Leads, Administrator(s),
  About Script) all call `genericPage()`: hardcoded
  `128 / 96 / 12 / 20` stat numbers and the literal empty state
  *"This section is a front-end demo. Connect a backend to manage live …"*.

* **Everything is in-memory.** No persistence, no network calls, no auth. Every
  "save"/"create"/"export" is a `prompt()`/`alert()`/`remove()` on the DOM.
  A page reload discards all state.

---

## 2. Assumptions made before coding

1. **All values, names, emails, balances, prices and marketing statistics are
   demonstration content**, exactly as the files themselves state. Nothing is
   verified or real, and the backend must not present it as real.
2. The backend serves **only the admin workflows that have real content**:
   dashboard summary, users, withdrawals, payment methods, payment settings —
   plus authentication/audit infrastructure to do that safely.
3. Dashboard cards that the files label as demo and that are outside the
   permitted scope (deposits, investments) are returned as **explicitly flagged
   demo aggregates** rather than invented live values.
4. Email addresses in the demo data are `example.com` / placeholder style and
   are **retained only as synthetic fixtures**, never used to send mail.
5. Monetary values are stored and transported as **integer minor units**
   (cents) with the currency taken from payment settings; the HTML's pre-formatted
   strings are reproduced as a convenience `*_display` field.
6. "KYC" is only a status label on a user (`pending` / `verified` / `rejected`).
   **No KYC document collection, storage or upload exists in this API.**
7. "Used for" maps to the HTML's `'both' | 'deposit' | 'withdraw'` vocabulary.
8. The demo `methods[]` duplicate `Litecoin` row is a data-quality defect in the
   demo; the backend enforces a unique method name and seeds it once.
9. Authentication is **admin-only** (the admin console is the only consumer).
   There is no public user sign-up, no password reset email, and no way to list
   or create administrators over HTTP.
10. Deleting a payment method is a **hard delete** (the demo's Delete button
    removes the row); users and withdrawals are **never deletable** through this
    API — only their display state can be changed — because no scope was granted.
11. The admin console will eventually be served by this same backend over
    HTTP(S); therefore auth is designed around an httpOnly session cookie plus a
    `Authorization: Bearer` alternative, with CSRF protection on writes.

---

## 3. Quick start

```bash
cd backend
cp .env.example .env        # then edit .env — see docs/SETUP.md
npm install
npm run migrate             # create the schema (needs DB_MIGRATION_USER — see docs/SETUP.md §2.2)
npm run admin:create        # provision the first administrator (interactive)
npm run dev                 # API on http://localhost:4000
```

Swagger-style reference: [`openapi.yaml`](openapi.yaml) and
[`docs/API_CONTRACT.md`](docs/API_CONTRACT.md).

If a local MariaDB/MySQL server is already running on `127.0.0.1:3306`,
`scripts/setup-local-db.mjs` automates the whole local setup — both schemas, two
least-privilege users with generated passwords, and a generated `.env`:

```bash
ROOT_DB_PASSWORD=<root password> node scripts/setup-local-db.mjs
npm run migrate && npm run seed -- --yes && npm run admin:create && npm run dev
```

## Verification status

| Check | Command | Result |
|---|---|---|
| Offline unit suite (no DB needed) | `npm test` | **122 / 122 pass** |
| Same suite against a real database | `npm run test:mysql` | **122 / 122 pass** (MariaDB 11.4.5) |
| Schema migration | `npm run migrate` | 001 + 002 applied, 12 tables |
| Full-stack smoke test | `npm run smoke:db` | **38 / 38 pass** |
| Running admin dev server | `node scripts/verify-dev-server.mjs` | pass |
| Live admin endpoint sweep | `node scripts/sweep.mjs` | **206 / 206 pass** |
| Live customer portal verification | `node scripts/verify-customer-server.mjs` | **30 / 30 pass** |
| Config + migration static checks | `npm run check` | clean |
| Capacity benchmark | `node scripts/bench.mjs` | see [`docs/CAPACITY.md`](docs/CAPACITY.md) |

Running against a real database caught **four product bugs and three harness
bugs** that the offline mode could not — including a MySQL-8-only `CAST(? AS JSON)`
that broke every audited write, a reference allocator that produced `PAY-00000`
and then skipped a number, and a safety guard that was placed *after* the
destructive step it was meant to prevent. All are fixed and regression-tested —
see `docs/TESTING.md` §0 for the full list.

## Two APIs, one database

- **Admin API** — [`docs/API_CONTRACT.md`](docs/API_CONTRACT.md): dashboard,
  users, withdrawals, payment methods, settings, audit log.
- **Customer portal API** — [`docs/CUSTOMER_API.md`](docs/CUSTOMER_API.md):
  sign-in, profile, dashboard, withdrawal history, KYC status, payment methods.

Both read the same `users`, `withdrawals`, `payment_methods` and
`payment_settings` rows — there is no second copy and no sync step. Customer
and administrator tokens are in separate JWT **audiences**, so neither can call
the other's routes even though both share one signing secret. Customer identity
comes from the signed token only, never from a request parameter.

## Verification that the supplied HTML is untouched

SHA-256 of the two files as supplied (before any work):

```
85d4ed53f22b4c46caf30fc4a3f8e13938f42f0e10c81d0df992f3abe3a43a39  admin.html  24341 bytes
9010f87bdcdcec0a237c5a16ab87917de981e6d8cf07b1f26cbc8b12edac0269  index.html  31256 bytes
```

Re-compute at any time:

```powershell
Get-FileHash -Algorithm SHA256 admin.html, index.html
```

Neither file was edited, reformatted, renamed or regenerated. Their CSS, inline
JavaScript, layout, visual design, text and assets are byte-for-byte identical.
No file was added to their directories.

See **[`docs/SETUP.md`](docs/SETUP.md)** for the full local / test / production
walkthrough and **[`docs/DEPLOYMENT_HOSTINGER.md`](docs/DEPLOYMENT_HOSTINGER.md)**
for Hostinger guidance.
