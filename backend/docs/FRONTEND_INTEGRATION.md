# Frontend Integration Notes (for the next task)

Nothing here has been changed in `index.html` or `admin.html`. This document
records what a later task should do to connect them, and why.

---

## 1. Why `file://` cannot work

Both files were supplied as local paths and are currently opened with a `file://`
URL. A page served from `file://`:

- has the opaque origin `null`;
- cannot receive or send cookies with `SameSite`/`Secure` attributes, so the
  httpOnly session cookie this API uses will not persist;
- is treated as an untrusted origin, so this API's explicit CORS allow-list
  rejects it (a wildcard is refused by configuration validation, by design);
- cannot be secured over HTTPS, so any token the page did manage to store would
  be readable by any script or extension on the machine.

So: **the supplied admin console cannot authenticate to this API as a deployed
website while it is opened with `file://`**, and no amount of client-side code
changes that.

---

## 2. What the later task should do

### 2.1 Serve the pages over HTTP(S)

Serve both files from the same origin as the API, or from a dedicated admin
origin that is listed in `CORS_ALLOWED_ORIGINS`.

Simplest option — same origin (no CORS at all, strongest posture):

```
https://admin.your-domain.example/            -> admin.html, index.html
https://admin.your-domain.example/api/v1/     -> this backend
```

Then the browser sends the session cookie automatically, and no cross-origin
configuration is needed.

Alternative — separate origins:
```
https://scalpsphere.your-domain.example/        -> index.html (public site)
https://admin.scalpsphere.your-domain.example/ -> admin.html
https://api.scalpsphere.your-domain.example/   -> this backend
```
with `CORS_ALLOWED_ORIGINS=https://admin.scalpsphere.your-domain.example,https://scalpsphere.your-domain.example`
and `COOKIE_SAMESITE=none` + `COOKIE_SECURE=true`.

### 2.2 Do not change the visual design

The instruction for the later task is to add `fetch()` calls, not to redesign
anything. Concretely:

- **Keep the existing CSS, layout, text, markup, tables, cards, pills, charts
  and colours exactly as they are.**
- Keep the same classes (`.stat`, `.pill.green`, `.method-grid`, `.fieldgrid`,
  `.tabletools`, `.pagination`, …) and the same rendered values.
- The API already returns display-ready strings next to every numeric value so
  that the existing templates keep working unchanged:

  | HTML shows | API field |
  |---|---|
  | `$450.00` | `balance_display` (plus `balance_minor`) |
  | `$1,250.00` | `balance_display` |
  | `Active` / `Inactive` | `status` (values already match) |
  | `Verified` / `Pending` | `kyc_status` |
  | `$537` in a withdrawal row | `amount_display` |
  | `Pending` / `Processed` | `status` |
  | Method type `crypto` / `currency` | `type` |
  | Used-for `both` / `deposit` / `withdraw` | `used_for` |

  The status values in the API (`active`, `inactive`, `pending`, `processed`,
  `enabled`, `disabled`, `verified`, `rejected`) are lower-case; the HTML's
  `statusPill()` capitalises by CSS, so map them once in the renderer rather
  than changing the markup.

### 2.3 Minimal client plumbing

```html
<script type="module">
const API = '/api/v1';

async function api(path, options = {}) {
  const res = await fetch(API + path, {
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(options.method && options.method !== 'GET'
        ? { 'X-CSRF-Token': getCookie('csrf_token') }
        : {}),
    },
    ...options,
  });
  if (res.status === 401) { location.href = '/login.html'; return null; }
  return res.json();
}

function getCookie(name) {
  return document.cookie
    .split('; ')
    .find((r) => r.startsWith(name + '='))
    ?.split('=')[1] ?? '';
}
</script>
```

Then replace each demo array read with a fetch:

| Existing demo source | Replace with |
|---|---|
| `users[]` | `GET /api/v1/users?search=&status=&page=&per_page=` |
| `withdrawals[]` | `GET /api/v1/withdrawals?search=&status=&page=&per_page=` |
| `methods[]` | `GET /api/v1/payment-methods?search=&type=&used_for=&status=` |
| `stats()` four cards | `GET /api/v1/dashboard/summary` → `cards` |
| `dataTableInlineUsers()` | `GET /api/v1/dashboard/recent-users` |
| recent withdrawals panel | `GET /api/v1/dashboard/summary` → `recent_withdrawals` |
| activity SVG paths | `GET /api/v1/dashboard/activity?range=7d\|30d` → `points[].deposits_minor` |
| `addMethod()` `prompt()` | `POST /api/v1/payment-methods` |
| `toggleMethod()` | `POST /api/v1/payment-methods/:id/enable` \| `disable` |
| Delete button `remove()` | `DELETE /api/v1/payment-methods/:id` |
| Settings form "Save changes" `alert()` | `PUT /api/v1/payment-settings` |
| "View" buttons `alert()` | `GET /api/v1/users/:id` / `GET /api/v1/withdrawals/:id` |
| `exportCSV()` | `GET /api/v1/users?...` (fetch all pages with `per_page=100`) |

### 2.4 Pagination in the existing footer

The current footer is:

```
Showing X to Y of Z entries   Previous   1   Next
```

`meta.pagination` provides every one of those numbers, so the footer can be
populated without touching its markup.

### 2.5 Session bootstrap

```js
// On page load:
const me = await api('/auth/me');
if (!me?.success) location.href = '/login.html';
```

Keep the current "System online / Administrator / SA" topbar, or populate
SA`
from `/auth/me` — either is a one-line change, not a redesign.

### 2.6 A login page is still needed

The supplied `admin.html` has no login form (it is a single file with no auth
code). The later task must add **one new file** (e.g. `login.html`) that posts to
`POST /api/v1/auth/login`. Adding a file does not change either supplied page.

---

## 3. What must NOT be exposed by the frontend

Because the HTML labels all current figures as demo content, the integration must
carry that provenance through:

- any card whose `is_demo` is `true` (`total_deposits`, `active_investments`)
  must keep a visible "demo data" marker;
- the API returns `demo_environment: true` from `/health` — surface it rather
  than hiding it;
- do not present `receiver_email` values as real payout destinations; they are
  synthetic fixtures.

---

## 4. Deliberately unchanged

For the record, this task:

- did **not** edit, reformat, rename or regenerate `admin.html` or `index.html`;
- did **not** change their CSS, inline JavaScript, layout, visual design, text or
  assets;
- did **not** add or remove a single character from either file.

See the Verification section in [`README.md`](../README.md).
