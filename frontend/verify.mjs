#!/usr/bin/env node
/**
 * Admin-UI verification sweep — "press every button", at the level the UI
 * actually presses them.
 *
 *   node frontend/verify.mjs
 *
 * Assumes the backend is running on 127.0.0.1:4000 and starts its own copy of
 * the frontend dev server on an ephemeral port. It then walks the UI's real
 * HTTP surface end to end:
 *
 *   A. Every page and asset the shell loads returns 200 and parses.
 *   B. Every section in the navigation has a registered view (no dead buttons).
 *   C. Every data call each supported screen makes, with real auth + CSRF.
 *   D. Every WRITE the UI can perform, plus a check that nothing was written
 *      when the write is refused.
 *   E. Role gating: signs in as `support` and proves the writes the UI hides
 *      are genuinely refused by the backend (403), and that audit-log is
 *      owner-only.
 *   F. Unauthenticated access is refused (the login redirect is justified).
 *
 * No headless browser is installed in this environment, so this drives the
 * network layer the browser would drive, using the same cookies and headers.
 * Structure-level checks (B) cover the "button exists but goes nowhere" class
 * of bug that a browser sweep would catch.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = process.env.SS_API_TARGET ?? 'http://127.0.0.1:4000';
const OWNER_EMAIL = process.env.SWEEP_EMAIL ?? 'admin@scalpsphere.local';
const OWNER_PASSWORD = process.env.SWEEP_PASSWORD ?? 'Local-Dev!Admin#2026x';
const SUPPORT_EMAIL = 'sweep-support@scalpsphere.local';
const SUPPORT_PASSWORD = 'Sw33p!Support#2026x';

let pass = 0;
let fail = 0;
const failures = [];
const check = (label, cond, detail = '') => {
  const line = `${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : `  ->  ${detail}`}`;
  console.log(line);
  if (cond) pass += 1;
  else { fail += 1; failures.push(label); }
};

// ---- start the frontend dev server on an ephemeral port -------------------
const servePath = path.join(HERE, 'serve.mjs');
const { spawn } = await import('node:child_process');
const uiPort = 18000 + Math.floor(Math.random() * 4000);
const ui = spawn(process.execPath, [servePath], {
  env: { ...process.env, SS_PORT: String(uiPort), SS_API_TARGET: BACKEND, SS_HOST: '127.0.0.1' },
  stdio: ['ignore', 'ignore', 'inherit'],
});
const UI_BASE = `http://127.0.0.1:${uiPort}`;
await new Promise((r) => setTimeout(r, 700));

function stop() { ui.kill(); }
process.on('exit', stop);

// ---- tiny cookie-jar client over the UI origin (so the proxy is exercised) --
function client() {
  const jar = new Map();
  return {
    jar,
    async call(method, relPath, { body, headers = {} } = {}) {
      const h = { Accept: 'application/json', ...headers };
      if (body !== undefined) h['Content-Type'] = 'application/json';
      const cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
      if (cookie) h.Cookie = cookie;
      if (!['GET', 'HEAD'].includes(method)) {
        const t = jar.get('csrf_token');
        if (t) h['X-CSRF-Token'] = t;
      }
      const res = await fetch(UI_BASE + relPath, {
        method, headers: h,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'manual',
      });
      for (const raw of res.headers.getSetCookie?.() ?? []) {
        const [pair] = raw.split(';').map((s) => s.trim());
        const eq = pair.indexOf('=');
        if (eq > 0) jar.set(pair.slice(0, eq), pair.slice(eq + 1));
      }
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* not JSON */ }
      return { status: res.status, json, text };
    },
  };
}

async function staticOk(rel, wantIncludes = []) {
  const res = await fetch(`${UI_BASE}${rel}`);
  const ok200 = res.status === 200;
  const body = ok200 ? await res.text() : '';
  check(`GET ${rel} -> 200`, ok200, `got ${res.status}`);
  for (const needle of wantIncludes) check(`  contains ${JSON.stringify(needle)}`, body.includes(needle));
}

function sectionIdsFromHtml() {
  const html = fs.readFileSync(path.join(HERE, 'index.html'), 'utf8');
  return html; // nav is built by JS, so sections are verified from app.js below
}

// =============================================================================
console.log('\n=== A. Pages and assets the shell loads ===');
await staticOk('/login.html', ['assets/config.js', 'assets/api.js', 'assets/login.js', 'Sign in']);
await staticOk('/', ['assets/app.js', 'assets/ui.js', 'id="sidebar"', 'Skip to content']);
await staticOk('/index.html');
await staticOk('/assets/styles.css', [':root', '--accent: #83ff53']);
await staticOk('/assets/config.js', ['apiBase']);
await staticOk('/assets/api.js', ['X-CSRF-Token', '/auth/refresh']);
await staticOk('/assets/ui.js', ['stateNotAvailable', 'buildPagination']);
await staticOk('/assets/login.js', ['SS.login']);
await staticOk('/assets/app.js', ['viewDashboard', 'viewNotAvailable']);

// Unknown deep link falls back to the shell (SPA behaviour)
await staticOk('/users', ['assets/app.js']);

// API is reachable through the proxy, unauthenticated
{
  const res = await fetch(`${UI_BASE}/api/v1/health`);
  const j = await res.json().catch(() => null);
  check('GET /api/v1/health via UI proxy -> 200 ok', res.status === 200 && j?.data?.status === 'ok');
}

// =============================================================================
console.log('\n=== B. Navigation inventory has a view behind every button ===');
{
  const app = fs.readFileSync(path.join(HERE, 'assets', 'app.js'), 'utf8');
  const sectionMatches = [...app.matchAll(/\{ id: '([\w-]+)',\s*icon:/g)].map((m) => m[1]);
  check('section inventory parsed', sectionMatches.length >= 18, `found ${sectionMatches.length}`);

  const viewsBlock = app.match(/const views = \{([\s\S]*?)\n  \};/)?.[1] ?? '';
  // Keys in the views map are unquoted (dashboard: viewDashboard), so the
  // quote is optional here. Matching only quoted keys made every implemented
  // section look unimplemented — a sweep bug, not an app bug.
  const implemented = new Set([...viewsBlock.matchAll(/^\s*'?([\w-]+)'?:\s/gm)].map((m) => m[1]));
  const naBlock = app.match(/const NA = \{([\s\S]*?)\n  \};/)?.[1] ?? '';
  // Keys are quoted for hyphenated ids and unquoted otherwise, so both forms
  // are collected into ONE array — new Set(a, b) silently drops b.
  const notAvailable = new Set([
    ...[...naBlock.matchAll(/^\s*'([\w-]+)':\s*\{/gm)].map((m) => m[1]),
    ...[...naBlock.matchAll(/^\s*([\w-]+):\s*\{/gm)].map((m) => m[1]),
  ]);

  for (const id of sectionMatches) {
    const hasView = implemented.has(id) || notAvailable.has(id);
    check(`section "${id}" renders something`, hasView, 'neither a view nor a NotAvailable state');
  }
  // Every view that exists must be reachable from the nav, and vice versa.
  for (const id of implemented) {
    check(`view "${id}" is in the navigation`, sectionMatches.includes(id));
  }
  check('dashboard is implemented', implemented.has('dashboard'));
  check('settings is implemented', implemented.has('settings'));
  check('audit-log is implemented (owner extra)', implemented.has('audit-log'));
}

// =============================================================================
console.log('\n=== F. Unauthenticated access is refused (login redirect is justified) ===');
{
  const c = client();
  const res = await c.call('GET', '/api/v1/users');
  check('GET /users with no session -> 401', res.status === 401, `got ${res.status}`);
  const res2 = await c.call('POST', '/api/v1/payment-methods', { name: 'Nope', type: 'crypto', used_for: 'both' });
  check('write with no session -> 401', res2.status === 401, `got ${res2.status}`);
}

// =============================================================================
console.log('\n=== C+D. Owner session: every supported screen and every write ===');
{
  const c = client();
  const login = await c.call('POST', '/api/v1/auth/login', { body: { email: OWNER_EMAIL, password: OWNER_PASSWORD } });
  check('owner login -> 200', login.status === 200, JSON.stringify(login.json).slice(0, 120));
  const csrf = c.jar.get('csrf_token');
  check('  csrf cookie issued', Boolean(csrf));

  const me = await c.call('GET', '/api/v1/auth/me');
  check('GET /auth/me -> 200', me.status === 200);
  check('  role reported', Boolean(me.json?.data?.role));

  // --- Dashboard -----------------------------------------------------------
  const sum = await c.call('GET', '/api/v1/dashboard/summary');
  check('GET /dashboard/summary -> 200', sum.status === 200);
  check('  four cards present', Object.keys(sum.json?.data?.cards ?? {}).length === 4);
  check('  recent users panel', Array.isArray(sum.json?.data?.recent_users));
  check('  recent withdrawals panel', Array.isArray(sum.json?.data?.recent_withdrawals));
  for (const range of ['7d', '30d']) {
    const act = await c.call('GET', `/api/v1/dashboard/activity?range=${range}`);
    check(`GET /dashboard/activity?range=${range} -> 200`, act.status === 200);
  }
  const ru = await c.call('GET', '/api/v1/dashboard/recent-users?limit=5');
  check('GET /dashboard/recent-users -> 200', ru.status === 200 && (ru.json?.data?.length ?? 0) <= 5);

  // --- Users (list, search, filters, sort, pagination, detail) ---------------
  const users = await c.call('GET', '/api/v1/users?page=1&per_page=10&sort=balance&direction=asc');
  check('GET /users -> 200 with pagination', users.status === 200 && Boolean(users.json?.meta?.pagination));
  check('  facets present', Boolean(users.json?.meta?.facets));
  const searched = await c.call('GET', '/api/v1/users?search=white');
  check('GET /users?search= -> 200', searched.status === 200);
  const filtered = await c.call('GET', '/api/v1/users?status=active&kyc_status=verified');
  check('GET /users?status=&kyc_status= -> 200', filtered.status === 200);
  const badSort = await c.call('GET', '/api/v1/users?sort=password_hash');
  check('GET /users?sort=<forbidden> -> 422', badSort.status === 422);
  const facets = await c.call('GET', '/api/v1/users/facets');
  check('GET /users/facets -> 200', facets.status === 200);
  if ((users.json?.data?.length ?? 0) > 0) {
    const ref = users.json.data[0].id;
    const one = await c.call('GET', `/api/v1/users/${encodeURIComponent(ref)}`);
    check(`GET /users/:id (${ref}) -> 200`, one.status === 200);
    check('  detail includes recent_withdrawals', Array.isArray(one.json?.data?.recent_withdrawals));
  }

  // --- Withdrawals (list, filters, facets, detail) --------------------------
  const wd = await c.call('GET', '/api/v1/withdrawals?page=1&per_page=10');
  check('GET /withdrawals -> 200 with pagination', wd.status === 200 && Boolean(wd.json?.meta?.pagination));
  const wdf = await c.call('GET', '/api/v1/withdrawals/facets');
  check('GET /withdrawals/facets -> 200', wdf.status === 200);
  check('  pending totals present', typeof wdf.json?.data?.pending?.count === 'number');
  const wdq = await c.call('GET', '/api/v1/withdrawals?status=pending&from=2026-01-01&to=2026-12-31');
  check('GET /withdrawals?status&from&to -> 200', wdq.status === 200);
  if ((wd.json?.data?.length ?? 0) > 0) {
    const ref = wd.json.data[0].id;
    const one = await c.call('GET', `/api/v1/withdrawals/${encodeURIComponent(ref)}`);
    check(`GET /withdrawals/:id (${ref}) -> 200`, one.status === 200);
  }
  // The UI offers no review buttons; confirm none would work anyway.
  const noAction = await c.call('POST', '/api/v1/withdrawals/WDR-00001/approve');
  check('POST /withdrawals/:id/approve does not exist -> 404', noAction.status === 404, `got ${noAction.status}`);

  // --- KYC read-only status view --------------------------------------------
  const kycPending = await c.call('GET', '/api/v1/users?kyc_status=pending&per_page=20');
  check('GET /users?kyc_status=pending (KYC view) -> 200', kycPending.status === 200);

  // --- Settings: preferences read + currencies -------------------------------
  const ps = await c.call('GET', '/api/v1/payment-settings');
  check('GET /payment-settings -> 200', ps.status === 200);
  const cur = await c.call('GET', '/api/v1/payment-settings/currencies');
  check('GET /payment-settings/currencies -> 200', cur.status === 200);
  check('  currency options', (cur.json?.data?.currencies ?? []).length >= 3);

  // --- Settings: payment methods CRUD (every write the UI performs) ---------
  const list = await c.call('GET', '/api/v1/payment-methods?per_page=100');
  check('GET /payment-methods -> 200', list.status === 200);
  const before = list.json?.meta?.pagination?.total ?? 0;

  const stamp = Date.now();
  const created = await c.call('POST', '/api/v1/payment-methods', {
    body: { name: `Sweep UI Coin ${stamp}`, type: 'crypto', used_for: 'both', status: 'disabled' },
  });
  check('POST /payment-methods (Add New) -> 201', created.status === 201, JSON.stringify(created.json).slice(0, 200));
  const mid = created.json?.data?.id;

  const dup = await c.call('POST', '/api/v1/payment-methods', {
    body: { name: `sweep ui coin ${stamp}`, type: 'crypto', used_for: 'both' },
  });
  check('POST duplicate name (server 409 shown in dialog) -> 409', dup.status === 409, JSON.stringify(dup.json).slice(0, 160));
  const inval = await c.call('POST', '/api/v1/payment-methods', {
    body: { name: 'x', type: 'crypto', used_for: 'both' },
  });
  check('POST invalid name (server 422 mapped to fields) -> 422', inval.status === 422);
  check('  422 names the offending field', (inval.json?.error?.details ?? []).some((d) => d.field === 'name'));

  const patched = await c.call('PATCH', `/api/v1/payment-methods/${encodeURIComponent(mid)}`, {
    body: { name: `Sweep UI Coin ${stamp} v2`, used_for: 'deposit', status: 'enabled' },
  });
  check('PATCH /payment-methods/:id (Edit) -> 200', patched.status === 200);
  check('  edit applied', patched.json?.data?.used_for === 'deposit');

  const en = await c.call('POST', `/api/v1/payment-methods/${encodeURIComponent(mid)}/enable`);
  check('POST /:id/enable -> 200', en.status === 200 && en.json?.data?.status === 'enabled');
  const dis = await c.call('POST', `/api/v1/payment-methods/${encodeURIComponent(mid)}/disable`);
  check('POST /:id/disable -> 200', dis.status === 200 && dis.json?.data?.status === 'disabled');

  // Preferences save (PUT), then restore the original values.
  const saved = await c.call('PUT', '/api/v1/payment-settings', {
    body: {
      default_currency: ps.json.data.default_currency,
      processing_mode: ps.json.data.processing_mode,
      payment_instructions: ps.json.data.payment_instructions ?? 'Sweep verify',
      minimum_deposit: (ps.json.data.minimum_deposit_minor / 100).toFixed(2),
      minimum_withdrawal: (ps.json.data.minimum_withdrawal_minor / 100).toFixed(2),
    },
  });
  check('PUT /payment-settings (Save changes) -> 200', saved.status === 200, JSON.stringify(saved.json).slice(0, 200));
  const badPut = await c.call('PUT', '/api/v1/payment-settings', {
    body: { default_currency: 'USD', processing_mode: 'automatic' },
  });
  check('PUT missing required fields -> 422', badPut.status === 422);

  const del = await c.call('DELETE', `/api/v1/payment-methods/${encodeURIComponent(mid)}`);
  check('DELETE /payment-methods/:id -> 204', del.status === 204);
  const delAgain = await c.call('DELETE', `/api/v1/payment-methods/${encodeURIComponent(mid)}`);
  check('DELETE twice -> 404 (no phantom success)', delAgain.status === 404);
  const afterList = await c.call('GET', '/api/v1/payment-methods?per_page=100');
  check('method count restored after delete', (afterList.json?.meta?.pagination?.total ?? 0) === before);

  // --- Audit log (owner) -----------------------------------------------------
  const audit = await c.call('GET', '/api/v1/audit-log?per_page=5');
  check('GET /audit-log (owner) -> 200', audit.status === 200);
  const actions = new Set((audit.json?.data ?? []).map((e) => e.action));
  check('  writes were audited', actions.has('payment_method.created') || actions.has('payment_method.updated') || actions.has('payment_method.deleted'));
  const auditText = JSON.stringify(audit.json).toLowerCase();
  check('  no credential values in audit entries',
    !auditText.includes(OWNER_PASSWORD.toLowerCase()) && !/\$2[aby]\$[0-9a-z./]{53}/.test(auditText));

  // --- Administrators: change-password is NOT executed against the real owner
  // (it would revoke our own session); instead confirm the endpoint exists and
  // refuses a wrong current password, which is the path the dialog shows.
  const badPw = await c.call('POST', '/api/v1/auth/change-password', {
    body: { current_password: 'definitely-wrong', new_password: 'An0ther!Str0ng#Pass' },
  });
  check('POST /auth/change-password with wrong current -> 400', badPw.status === 400, `got ${badPw.status}`);
  const weakPw = await c.call('POST', '/api/v1/auth/change-password', {
    body: { current_password: OWNER_PASSWORD, new_password: 'weak' },
  });
  check('POST /auth/change-password weak new password -> 422', weakPw.status === 422);

  // --- About -----------------------------------------------------------------
  const health = await c.call('GET', '/api/v1/health');
  check('GET /health (About view) -> 200', health.status === 200);
  check('  api_version present', Boolean(health.json?.data?.api_version));

  // --- Logout ------------------------------------------------------------------
  const out = await c.call('POST', '/api/v1/auth/logout');
  check('POST /auth/logout -> 200', out.status === 200);
  const after = await c.call('GET', '/api/v1/users');
  check('  session really gone -> 401', after.status === 401);
}

// =============================================================================
console.log('\n=== E. Role gating: support sees what the UI will and will not allow ===');
{
  const c = client();
  const login = await c.call('POST', '/api/v1/auth/login', { body: { email: SUPPORT_EMAIL, password: SUPPORT_PASSWORD } });
  if (login.status !== 200) {
    check('support login (provision via CLI first)', false, `got ${login.status} — run: npm run admin:create -- --email ${SUPPORT_EMAIL} --role support`);
  } else {
    check('support login -> 200', true);
    const reads = [
      ['GET', '/api/v1/users?page=1&per_page=5', 'users list'],
      ['GET', '/api/v1/withdrawals?page=1&per_page=5', 'withdrawals list'],
      ['GET', '/api/v1/payment-methods?per_page=5', 'payment methods list'],
      ['GET', '/api/v1/payment-settings', 'payment settings'],
      ['GET', '/api/v1/dashboard/summary', 'dashboard'],
    ];
    for (const [m, p, label] of reads) {
      const r = await c.call(m, p);
      check(`support can read ${label} -> 200`, r.status === 200, `got ${r.status}`);
    }
    const writes = [
      ['POST', '/api/v1/payment-methods', { name: `Support Attempt ${Date.now()}`, type: 'crypto', used_for: 'both' }, 'create method'],
      ['PUT', '/api/v1/payment-settings', { default_currency: 'USD', processing_mode: 'automatic', payment_instructions: 'x', minimum_deposit: '10.00', minimum_withdrawal: '10.00' }, 'save settings'],
    ];
    for (const [m, p, body, label] of writes) {
      const r = await c.call(m, p, { body });
      check(`support write (${label}) refused -> 403`, r.status === 403, `got ${r.status}`);
    }
    const audit = await c.call('GET', '/api/v1/audit-log?per_page=5');
    check('support audit-log refused -> 403 (UI hides the section)', audit.status === 403, `got ${audit.status}`);
  }
}

// =============================================================================
console.log(`\n=== SWEEP COMPLETE: ${pass} passed, ${fail} failed ===`);
if (failures.length) {
  console.log('Failures:');
  failures.forEach((f) => console.log(`  - ${f}`));
  process.exitCode = 1;
}
process.exit(process.exitCode ?? 0);
