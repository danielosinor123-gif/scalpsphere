#!/usr/bin/env node
/**
 * Full endpoint sweep: exercises EVERY route, every HTTP method, every query
 * parameter and every documented error path against a RUNNING instance, and
 * prints a PASS/FAIL matrix.
 *
 *   node scripts/sweep.mjs [baseUrl]
 *
 * Default target: http://127.0.0.1:4000/api/v1
 *
 * Creates one throwaway support-role administrator (via the CLI, the only way
 * an admin can exist) to verify the role gate, change-password and logout-all
 * without touching the real owner account. That account is left inert: its
 * sessions are revoked at the end. Remove the row with:
 *   DELETE FROM admins WHERE email = 'sweep-support@scalpsphere.local';
 *
 * Total requests are kept well under the default RATE_LIMIT_API_MAX so the
 * sweep does not trip the limiter.
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import crypto from 'node:crypto';

const BASE = (process.argv[2] ?? 'http://127.0.0.1:4000') + '/api/v1';
const OWNER_EMAIL = process.env.SWEEP_EMAIL ?? 'admin@scalpsphere.local';
const OWNER_PASSWORD = process.env.SWEEP_PASSWORD ?? 'Local-Dev!Admin#2026x';
const SUPPORT_EMAIL = 'sweep-support@scalpsphere.local';
const SUPPORT_PASSWORD = 'Sw33p!Support#2026x';

// The JWT secret lives in the SERVER's .env, not in this process's environment.
// Read it so the "secret is never echoed" check compares against the real value
// instead of an empty string (which trivially matched and produced a false FAIL).
const ENV_FILE = fs.readFileSync(fileURLToPath(new URL('../.env', import.meta.url)), 'utf8');
const JWT_SECRET = ENV_FILE.match(/^JWT_ACCESS_SECRET=(.+)$/m)?.[1]?.trim();

let pass = 0;
let fail = 0;
const failures = [];

function section(name) {
  console.log(`\n=== ${name} ===`);
}

function record(ok, label, detail = '') {
  if (ok) {
    pass += 1;
    console.log(`PASS  ${label}`);
  } else {
    fail += 1;
    failures.push(`${label}${detail ? `  ->  ${detail}` : ''}`);
    console.log(`FAIL  ${label}${detail ? `  ->  ${detail}` : ''}`);
  }
}

/** A cookie-jar + bearer-token HTTP client. */
function makeClient() {
  const jar = new Map();
  const client = {
    async call(method, path, { body, headers = {}, auth } = {}) {
      const h = { 'Content-Type': 'application/json', ...headers };
      const cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
      if (cookie) h.Cookie = cookie;
      if (auth?.bearer) h.Authorization = `Bearer ${auth.bearer}`;
      if (auth?.csrf) h['X-CSRF-Token'] = auth.csrf;

      const res = await fetch(BASE + path, {
        method,
        headers: h,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'manual',
      });
      for (const raw of res.headers.getSetCookie?.() ?? []) {
        const [pair] = raw.split(';').map((s) => s.trim());
        const eq = pair.indexOf('=');
        jar.set(pair.slice(0, eq), pair.slice(eq + 1));
      }
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* 204 etc. */ }
      return { status: res.status, json, text, headers: res.headers };
    },
    jar,
  };
  return client;
}

const expectStatus = (label, res, want) =>
  record(res.status === want, label, `got ${res.status} ${res.text?.slice(0, 120)}`);

const expectStatusIn = (label, res, wants) =>
  record(wants.includes(res.status), label, `got ${res.status}, wanted one of ${wants.join('/')}`);

const expectTrue = (label, cond, detail = '') => record(Boolean(cond), label, detail);

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------
const owner = makeClient();

async function loginAs(c, email, password) {
  return c.call('POST', '/auth/login', { body: { email, password } });
}

// --- A. Health --------------------------------------------------------------
section('A. HEALTH (public)');
{
  const res = await owner.call('GET', '/health');
  expectStatus('GET /health -> 200', res, 200);
  expectTrue('health.status = ok', res.json?.data?.status === 'ok');
  expectTrue('db driver reported', res.json?.data?.checks?.driver === 'mysql');
  expectTrue('durable=true', res.json?.data?.checks?.durable === true);
  expectTrue('demo_environment=true', res.json?.data?.demo_environment === true);
  expectTrue('authenticated_as null when anonymous', res.json?.data?.authenticated_as === null);
  expectTrue('X-Request-Id header present', Boolean(res.headers.get('x-request-id')));
  expectTrue('no framework banner', res.headers.get('x-powered-by') === null);
  expectTrue('no db name leaked', !res.text.includes('scalpsphere'));
}
{
  const res = await owner.call('GET', '/health', { auth: { bearer: 'not-a-real-token' } });
  expectStatus('GET /health with garbage bearer -> 200 (health is public)', res, 200);
}

// --- B. Auth ----------------------------------------------------------------
section('B. AUTHENTICATION');
{
  const res = await loginAs(owner, OWNER_EMAIL, OWNER_PASSWORD);
  expectStatus('POST /auth/login valid -> 200', res, 200);
  expectTrue('returns access_token', Boolean(res.json?.data?.access_token));
  expectTrue('returns csrf_token', Boolean(res.json?.data?.csrf_token));
  expectTrue('token_type Bearer', res.json?.data?.token_type === 'Bearer');
  expectTrue('admin role owner', res.json?.data?.admin?.role === 'owner');
  expectTrue('cookies set', owner.jar.has('access_token') && owner.jar.has('csrf_token'));
  expectTrue('password not echoed', !res.text.includes(OWNER_PASSWORD));
}
const OWNER_TOKEN = (await loginAs(owner, OWNER_EMAIL, OWNER_PASSWORD)).json?.data?.access_token;

// Deliberately a GETTER, not a snapshot. `GET /auth/csrf` and `POST /auth/refresh`
// both ROTATE the csrf_token and access_token cookies; capturing the values once
// made every later write send a stale header and fail with 403, which looked
// like 45 product failures but was this script's bug.
const auth = {
  get bearer() { return owner.jar.get('access_token') ?? OWNER_TOKEN; },
  get csrf() { return owner.jar.get('csrf_token'); },
};

// A separate client with an EMPTY jar, for tests that must carry no ambient
// credential at all. The owner client keeps its session cookies, so calling it
// "unauthenticated" was wrong — the cookie jar was silently authenticating.
const anon = makeClient();

{
  const res = await owner.call('POST', '/auth/login', { body: { email: 'nobody@example.com', password: 'x'.repeat(16) } });
  expectStatus('POST /auth/login unknown email -> 401', res, 401);
  expectTrue('code INVALID_CREDENTIALS', res.json?.error?.code === 'INVALID_CREDENTIALS');
  expectTrue('does not confirm account existence', !/nobody/i.test(res.text));
}
{
  const res = await owner.call('POST', '/auth/login', { body: { email: OWNER_EMAIL, password: 'Wrong!Password1' } });
  expectStatus('POST /auth/login wrong password -> 401', res, 401);
}
{
  const res = await owner.call('POST', '/auth/login', { body: { email: 'not-an-email', password: 'x' } });
  expectStatus('POST /auth/login malformed email -> 422', res, 422);
  expectTrue('details name the field', res.json?.error?.details?.some((d) => d.field === 'email'));
}
{
  const res = await owner.call('POST', '/auth/login', { body: { email: OWNER_EMAIL, password: OWNER_PASSWORD, is_admin: true } });
  expectStatus('POST /auth/login unknown field -> 422', res, 422);
  expectTrue('details name the unknown field', res.json?.error?.details?.some((d) => d.field === 'is_admin'));
}
{
  const res = await owner.call('GET', '/auth/me', { auth });
  expectStatus('GET /auth/me -> 200', res, 200);
  expectTrue('me.email matches', res.json?.data?.email === OWNER_EMAIL);
  expectTrue('no password_hash in payload', !res.text.includes('password_hash') && !/\$2[aby]\$/.test(res.text));
}
{
  const res = await anon.call('GET', '/auth/me');
  expectStatus('GET /auth/me with no credentials -> 401', res, 401);
  expectTrue('code UNAUTHENTICATED', res.json?.error?.code === 'UNAUTHENTICATED');
}
{
  const res = await owner.call('GET', '/users', { auth: { bearer: 'tampered.token.value' } });
  expectStatus('tampered bearer -> 401', res, 401);
}
{
  const res = await owner.call('GET', '/auth/csrf');
  expectStatus('GET /auth/csrf -> 200', res, 200);
  expectTrue('returns csrf token', Boolean(res.json?.data?.csrf_token));
}
{
  // Save the refresh cookie so the second call is a genuine REPLAY of a token
  // that has since been rotated and revoked.
  const firstRefreshCookie = owner.jar.get('refresh_token');
  const res = await owner.call('POST', '/auth/refresh', { auth: { csrf: auth.csrf } });
  expectStatus('POST /auth/refresh -> 200 (rotates)', res, 200);
  expectTrue('  refresh cookie was rotated', owner.jar.get('refresh_token') !== firstRefreshCookie);

  const replayClient = makeClient();
  replayClient.jar.set('refresh_token', firstRefreshCookie);
  replayClient.jar.set('csrf_token', owner.jar.get('csrf_token'));
  const replay = await replayClient.call('POST', '/auth/refresh', {
    auth: { csrf: owner.jar.get('csrf_token') },
  });
  expectStatus('replaying the revoked refresh cookie -> 401', replay, 401);
}

// --- C. Dashboard -----------------------------------------------------------
section('C. DASHBOARD');
{
  const res = await owner.call('GET', '/dashboard/summary', { auth });
  expectStatus('GET /dashboard/summary -> 200', res, 200);
  const d = res.json?.data ?? {};
  expectTrue('four cards', Object.keys(d.cards ?? {}).length === 4, Object.keys(d.cards ?? {}).join(','));
  expectTrue('card_order documented', Array.isArray(d.card_order) && d.card_order.length === 4);
  expectTrue('total_users live', d.cards?.total_users?.is_demo === false);
  expectTrue('total_deposits flagged demo', d.cards?.total_deposits?.is_demo === true);
  expectTrue('pending_withdrawals live', d.cards?.pending_withdrawals?.is_demo === false);
  expectTrue('active_investments flagged demo', d.cards?.active_investments?.is_demo === true);
  expectTrue('each card has display_value', Object.values(d.cards ?? {}).every((c) => c.display_value));
  expectTrue('recent_users panel', Array.isArray(d.recent_users));
  expectTrue('recent_withdrawals panel', Array.isArray(d.recent_withdrawals));
  expectTrue('activity panel present', Boolean(d.activity?.note));
}
for (const range of ['7d', '30d']) {
  const res = await owner.call('GET', `/dashboard/activity?range=${range}`, { auth });
  expectStatus(`GET /dashboard/activity?range=${range} -> 200`, res, 200);
  expectTrue(`  points length matches range`, res.json?.data?.points?.length === (range === '7d' ? 7 : 30));
}
{
  const res = await owner.call('GET', '/dashboard/activity?range=forever', { auth });
  expectStatus('GET /dashboard/activity?range=forever -> 422', res, 422);
}
{
  const res = await owner.call('GET', '/dashboard/recent-users?limit=3', { auth });
  expectStatus('GET /dashboard/recent-users?limit=3 -> 200', res, 200);
  expectTrue('  returns <= 3 rows', (res.json?.data ?? []).length <= 3);
}
for (const bad of ['limit=0', 'limit=99', 'limit=abc']) {
  const res = await owner.call('GET', `/dashboard/recent-users?${bad}`, { auth });
  expectStatus(`GET /dashboard/recent-users?${bad} -> 422`, res, 422);
}

// --- D. Users ---------------------------------------------------------------
section('D. USERS (read-only)');
{
  const res = await owner.call('GET', '/users?page=1&per_page=2', { auth });
  expectStatus('GET /users paginated -> 200', res, 200);
  const m = res.json?.meta?.pagination ?? {};
  expectTrue('pagination.page', m.page === 1);
  expectTrue('pagination.per_page', m.per_page === 2);
  expectTrue('pagination.total is a number', typeof m.total === 'number');
  expectTrue('pagination.total_pages', typeof m.total_pages === 'number');
  expectTrue('pagination.has_next/has_prev booleans', typeof m.has_next === 'boolean' && typeof m.has_prev === 'boolean');
  expectTrue('facets present', Boolean(res.json?.meta?.facets));
  const row = res.json?.data?.[0];
  expectTrue('row has id/name/email/balance', row && ['id', 'name', 'email', 'balance_minor', 'balance_display', 'status', 'kyc_status', 'is_demo'].every((k) => k in row));
  expectTrue('row id is USR-#####', /^USR-\d{5}$/.test(row?.id ?? ''), String(row?.id));
}
{
  const res = await owner.call('GET', `/users?search=${encodeURIComponent('Trayson')}`, { auth });
  expectStatus('GET /users?search=Trayson -> 200', res, 200);
  expectTrue('  finds the demo row', (res.json?.data ?? []).some((u) => u.name.includes('Trayson')));
}
for (const payload of ["' OR 1=1 --", "'; DROP TABLE users; --", "%' UNION SELECT password_hash FROM admins --"]) {
  const res = await owner.call('GET', `/users?search=${encodeURIComponent(payload)}`, { auth });
  expectTrue(`injection payload matches nothing (${payload.slice(0, 12)}…)`, res.status === 200 && res.json?.meta?.pagination?.total === 0, `got ${res.status}/${res.json?.meta?.pagination?.total}`);
}
for (const [q, expectRows] of [
  ['status=active', (r) => r.every((u) => u.status === 'active')],
  ['kyc_status=verified', (r) => r.every((u) => u.kyc_status === 'verified')],
  ['sort=balance&direction=asc', (r) => r.every((u, i) => i === 0 || u.balance_minor >= r[i - 1].balance_minor)],
  ['sort=name&direction=asc', (r) => r.every((u, i) => i === 0 || u.name >= r[i - 1].name)],
]) {
  const res = await owner.call('GET', `/users?${q}&per_page=100`, { auth });
  expectStatus(`GET /users?${q} -> 200`, res, 200);
  expectTrue(`  filter/sort respected`, expectRows(res.json?.data ?? []));
}
for (const bad of ['status=deleted', 'kyc_status=maybe', 'sort=password_hash', 'direction=sideways', 'page=0', 'per_page=500', 'page=abc', 'nonsense=1']) {
  const res = await owner.call('GET', `/users?${bad}`, { auth });
  expectStatus(`GET /users?${bad} -> 422`, res, 422);
}
{
  const res = await owner.call('GET', '/users/facets', { auth });
  expectStatus('GET /users/facets -> 200', res, 200);
  expectTrue('facets list statuses', (res.json?.data?.status ?? []).length === 2);
  expectTrue('facets list kyc statuses', (res.json?.data?.kyc_status ?? []).length === 2);
}
{
  const list = await owner.call('GET', '/users?per_page=1', { auth });
  const id = list.json?.data?.[0]?.id;
  const res = await owner.call('GET', `/users/${id}`, { auth });
  expectStatus(`GET /users/:id -> 200`, res, 200);
  expectTrue('  includes recent_withdrawals', Array.isArray(res.json?.data?.recent_withdrawals));
}
{
  const res = await owner.call('GET', '/users/USR-99999', { auth });
  expectStatus('GET /users/USR-99999 -> 404', res, 404);
  expectTrue('code NOT_FOUND', res.json?.error?.code === 'NOT_FOUND');
}
for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
  const res = await owner.call(method, '/users', { body: { full_name: 'x' }, auth });
  expectStatusIn(`${method} /users does not exist`, res, [404, 405]);
}

// --- E. Withdrawals ---------------------------------------------------------
section('E. WITHDRAWALS (read-only)');
{
  const res = await owner.call('GET', '/withdrawals?per_page=2', { auth });
  expectStatus('GET /withdrawals -> 200', res, 200);
  const row = res.json?.data?.[0];
  expectTrue('row carries amount/fee/net', row && ['amount_minor', 'fee_minor', 'net_minor', 'amount_display', 'fee_display', 'net_display', 'payment_method', 'receiver_email'].every((k) => k in row));
  expectTrue('net = amount - fee', row && row.net_minor === row.amount_minor - row.fee_minor);
}
{
  const res = await owner.call('GET', '/withdrawals?status=pending&per_page=100', { auth });
  expectStatus('GET /withdrawals?status=pending -> 200', res, 200);
  expectTrue('  only pending rows', (res.json?.data ?? []).every((w) => w.status === 'pending'));
}
{
  const res = await owner.call('GET', `/withdrawals?search=${encodeURIComponent('USDT')}`, { auth });
  expectStatus('GET /withdrawals?search=USDT -> 200', res, 200);
  expectTrue('  matches method', (res.json?.data ?? []).every((w) => w.payment_method.includes('USDT')));
}
{
  const res = await owner.call('GET', '/withdrawals?from=2026-10-01&to=2026-10-31', { auth });
  expectStatus('GET /withdrawals?from..to -> 200', res, 200);
}
{
  const res = await owner.call('GET', '/withdrawals?from=2026-12-01&to=2026-01-01', { auth });
  expectStatus('GET /withdrawals from>to -> 400', res, 400);
}
{
  const res = await owner.call('GET', '/withdrawals?status=approved', { auth });
  expectStatus('GET /withdrawals?status=approved -> 422', res, 422);
}
{
  const res = await owner.call('GET', '/withdrawals/facets', { auth });
  expectStatus('GET /withdrawals/facets -> 200', res, 200);
  expectTrue('pending queue totals', typeof res.json?.data?.pending?.count === 'number');
  expectTrue('statuses enumerated', (res.json?.data?.statuses ?? []).length === 4);
}
{
  const list = await owner.call('GET', '/withdrawals?per_page=1', { auth });
  const id = list.json?.data?.[0]?.id;
  const res = await owner.call('GET', `/withdrawals/${id}`, { auth });
  expectStatus('GET /withdrawals/:id -> 200', res, 200);
}
{
  const res = await owner.call('GET', '/withdrawals/WDR-99999', { auth });
  expectStatus('GET /withdrawals/WDR-99999 -> 404', res, 404);
}
for (const path of ['/withdrawals/WDR-00001/approve', '/withdrawals/WDR-00001/process']) {
  const res = await owner.call('POST', path, { auth });
  expectStatus(`POST ${path} does not exist`, res, 404);
}
for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
  const res = await owner.call(method, '/withdrawals', { body: { status: 'x' }, auth });
  expectStatusIn(`${method} /withdrawals does not exist`, res, [404, 405]);
}

// --- F. Payment methods ----------------------------------------------------
section('F. PAYMENT METHODS (the write surface)');
let createdId;
{
  const res = await owner.call('GET', '/payment-methods?per_page=100', { auth });
  expectStatus('GET /payment-methods -> 200', res, 200);
  expectTrue('facets present', Boolean(res.json?.meta?.facets));
  expectTrue('Litecoin seeded exactly once', (res.json?.data ?? []).filter((m) => m.name === 'Litecoin').length === 1);
}
{
  const res = await owner.call('GET', '/payment-methods?type=crypto&used_for=both&status=enabled&per_page=100', { auth });
  expectStatus('GET /payment-methods?type&used_for&status -> 200', res, 200);
  expectTrue('  filters respected', (res.json?.data ?? []).every((m) => m.type === 'crypto' && m.used_for === 'both' && m.status === 'enabled'));
}
{
  const res = await owner.call('POST', '/payment-methods', { body: { name: `Sweep Coin ${Date.now()}`, type: 'crypto', used_for: 'both' }, auth });
  expectStatus('POST /payment-methods valid -> 201', res, 201);
  createdId = res.json?.data?.id;
  expectTrue('created id is PAY-#####', /^PAY-\d{5}$/.test(createdId ?? ''), String(createdId));
  expectTrue('admin-created row is_demo=false', res.json?.data?.is_demo === false);
}
{
  const res = await owner.call('POST', '/payment-methods', { body: { name: 'usdc', type: 'crypto', used_for: 'both' }, auth });
  expectStatus('POST duplicate name (case-insensitive) -> 409', res, 409);
  expectTrue('code CONFLICT', res.json?.error?.code === 'CONFLICT');
}
for (const [label, body] of [
  ['missing name', { type: 'crypto', used_for: 'both' }],
  ['name too short', { name: 'X', type: 'crypto', used_for: 'both' }],
  ['bad type', { name: 'Valid Name', type: 'stocks', used_for: 'both' }],
  ['bad used_for', { name: 'Valid Name', type: 'crypto', used_for: 'sometimes' }],
  ['bad status', { name: 'Valid Name', type: 'crypto', used_for: 'both', status: 'approved' }],
  ['unknown field', { name: 'Valid Name', type: 'crypto', used_for: 'both', surprise: 1 }],
]) {
  const res = await owner.call('POST', '/payment-methods', { body, auth });
  expectStatus(`POST /payment-methods ${label} -> 422`, res, 422);
}
{
  const res = await owner.call('PATCH', `/payment-methods/${createdId}`, { body: { name: 'Sweep Coin Renamed', status: 'enabled' }, auth });
  expectStatus('PATCH /payment-methods/:id -> 200', res, 200);
  expectTrue('  rename + status applied', res.json?.data?.name === 'Sweep Coin Renamed' && res.json?.data?.status === 'enabled');
}
{
  const res = await owner.call('PATCH', '/payment-methods/PAY-99999', { body: { status: 'enabled' }, auth });
  expectStatus('PATCH unknown id -> 404', res, 404);
}
{
  const res = await owner.call('POST', `/payment-methods/${createdId}/enable`, { auth });
  expectStatus('POST /:id/enable -> 200', res, 200);
  expectTrue('  status enabled', res.json?.data?.status === 'enabled');
  const again = await owner.call('POST', `/payment-methods/${createdId}/enable`, { auth });
  expectStatus('POST /:id/enable is idempotent -> 200', again, 200);
}
{
  const res = await owner.call('POST', `/payment-methods/${createdId}/disable`, { auth });
  expectStatus('POST /:id/disable -> 200', res, 200);
  expectTrue('  status disabled', res.json?.data?.status === 'disabled');
}
{
  const res = await owner.call('DELETE', `/payment-methods/${createdId}`, { auth });
  expectStatus('DELETE /payment-methods/:id -> 204', res, 204);
  const gone = await owner.call('GET', `/payment-methods/${createdId}`, { auth });
  expectStatus('  GET after delete -> 404', gone, 404);
  const again = await owner.call('DELETE', `/payment-methods/${createdId}`, { auth });
  expectStatus('DELETE twice -> 404', again, 404);
}

// --- G. Settings ------------------------------------------------------------
section('G. PAYMENT SETTINGS');
{
  const res = await owner.call('GET', '/payment-settings', { auth });
  expectStatus('GET /payment-settings -> 200', res, 200);
  expectTrue('defaults USD/automatic/$10.00', res.json?.data?.default_currency === 'USD' && res.json?.data?.minimum_deposit_display === '$10.00');
}
{
  const res = await owner.call('GET', '/payment-settings/currencies', { auth });
  expectStatus('GET /payment-settings/currencies -> 200', res, 200);
  expectTrue('currencies USD/NGN/EUR', (res.json?.data?.currencies ?? []).map((c) => c.code).sort().join() === 'EUR,NGN,USD');
  expectTrue('modes automatic/manual_review', (res.json?.data?.processing_modes ?? []).map((m) => m.key).join() === 'automatic,manual_review');
}
{
  const res = await owner.call('PUT', '/payment-settings', {
    body: { default_currency: 'NGN', processing_mode: 'manual_review', payment_instructions: 'Sweep instructions.', minimum_deposit: '250.50', minimum_withdrawal: 1000 },
    auth,
  });
  expectStatus('PUT /payment-settings -> 200', res, 200);
  expectTrue('  NGN symbol applied', res.json?.data?.minimum_deposit_display === '₦250.50', String(res.json?.data?.minimum_deposit_display));
  expectTrue('  minor units converted', res.json?.data?.minimum_deposit_minor === 25050);
}
{
  const res = await owner.call('PATCH', '/payment-settings', { body: { minimum_withdrawal: '75.25' }, auth });
  expectStatus('PATCH /payment-settings partial -> 200', res, 200);
  expectTrue('  only that field changed', res.json?.data?.default_currency === 'NGN' && res.json?.data?.minimum_withdrawal_minor === 7525);
}
for (const [label, method, body, want] of [
  ['PUT missing required field', 'PUT', { default_currency: 'USD', processing_mode: 'automatic', minimum_deposit: 10 }, 422],
  ['PATCH bad currency', 'PATCH', { default_currency: 'GBP' }, 422],
  ['PATCH bad mode', 'PATCH', { processing_mode: 'automatic_please' }, 422],
  ['PATCH malformed amount', 'PATCH', { minimum_deposit: 'abc' }, 422],
  ['PATCH negative amount', 'PATCH', { minimum_deposit: -5 }, 422],
  ['PATCH too many decimals', 'PATCH', { minimum_deposit: '1.005' }, 422],
  ['PATCH absurd amount', 'PATCH', { minimum_deposit: '999999999.99' }, 400],
  ['PATCH unknown field', 'PATCH', { nonsense: 1 }, 422],
]) {
  const res = await owner.call(method, '/payment-settings', { body, auth });
  expectStatus(`${method} /payment-settings ${label} -> ${want}`, res, want);
}
{
  const res = await owner.call('PUT', '/payment-settings', {
    body: { default_currency: 'USD', processing_mode: 'automatic', minimum_deposit: 10, minimum_withdrawal: 10 },
    auth,
  });
  expectStatus('PUT restore USD defaults -> 200', res, 200);
}

// --- H. Audit log -----------------------------------------------------------
section('H. AUDIT LOG');
{
  const res = await owner.call('GET', '/audit-log?per_page=5', { auth });
  expectStatus('GET /audit-log -> 200', res, 200);
  const entries = res.json?.data ?? [];
  expectTrue('entries exist', entries.length > 0);
  expectTrue('each has action/summary/actor/created_at', entries.every((e) => e.action && e.summary && e.actor && e.created_at));
  const actions = new Set(entries.map((e) => e.action));
  expectTrue('payment_method.updated audited', await (async () => {
    const all = await owner.call('GET', '/audit-log?per_page=100', { auth });
    return (all.json?.data ?? []).some((e) => e.action === 'payment_method.updated');
  })());
  const lower = JSON.stringify(res.json);
  // Asserts credential VALUES are absent — not the words "password"/"token",
  // which legitimately appear in action names such as auth.password_changed.
  expectTrue(
    'no credential VALUES in audit entries',
    !/\$2[aby]\$[0-9a-zA-Z./]{53}/.test(lower) &&
      !lower.includes(OWNER_PASSWORD) &&
      !lower.includes(SUPPORT_PASSWORD),
  );
}
{
  const res = await owner.call('GET', '/audit-log?action=payment_method.created&per_page=5', { auth });
  expectStatus('GET /audit-log?action= -> 200', res, 200);
  expectTrue('  filtered to that action', (res.json?.data ?? []).every((e) => e.action === 'payment_method.created'));
}

// --- I. Security behaviours -------------------------------------------------
section('I. SECURITY BEHAVIOURS');
{
  const res = await owner.call('GET', '/health', { headers: { Origin: 'http://localhost:4000' } });
  expectTrue('CORS: allow-listed origin echoed', res.headers.get('access-control-allow-origin') === 'http://localhost:4000', res.headers.get('access-control-allow-origin'));
}
{
  const res = await owner.call('GET', '/health', { headers: { Origin: 'https://evil.example.com' } });
  expectStatus('CORS: unlisted origin rejected -> 403', res, 403);
  expectTrue('  no ACAO header for attacker', res.headers.get('access-control-allow-origin') === null);
}
{
  const pre = await fetch(`${BASE}/users`, {
    method: 'OPTIONS',
    headers: { Origin: 'http://localhost:4000', 'Access-Control-Request-Method': 'GET' },
  });
  expectTrue('CORS preflight handled', pre.status === 204 || pre.status === 200, `got ${pre.status}`);
  expectTrue('  methods advertised', (pre.headers.get('access-control-allow-methods') ?? '').includes('GET'));
}
{
  const res = await owner.call('POST', '/payment-methods', { body: { name: 'NoCsrf Coin', type: 'crypto', used_for: 'both' }, headers: { Authorization: `Bearer ${OWNER_TOKEN}` } });
  expectStatus('write without X-CSRF-Token -> 403', res, 403);
  expectTrue('  code CSRF_TOKEN_INVALID', res.json?.error?.code === 'CSRF_TOKEN_INVALID');
  const check = await owner.call('GET', `/payment-methods?search=${encodeURIComponent('NoCsrf Coin')}`, { auth });
  expectTrue('  nothing was written', check.json?.meta?.pagination?.total === 0);
}
{
  const res = await anon.call('POST', '/payment-methods', { body: { name: 'NoAuth Coin', type: 'crypto', used_for: 'both' } });
  expectStatus('write with no credentials at all -> 401', res, 401);
  expectTrue('  code UNAUTHENTICATED', res.json?.error?.code === 'UNAUTHENTICATED');
}
{
  const res = await fetch(`${BASE}/payment-methods`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth.bearer}`, 'X-CSRF-Token': auth.csrf },
    body: JSON.stringify({ name: 'X'.repeat(200_000), type: 'crypto', used_for: 'both' }),
  });
  expectTrue('oversized body -> 413', res.status === 413, `got ${res.status}`);
}
{
  const res = await fetch(`${BASE}/payment-settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth.bearer}`, 'X-CSRF-Token': auth.csrf },
    body: '{"default_currency":',
  });
  expectTrue('malformed JSON -> 400', res.status === 400, `got ${res.status}`);
  const txt = await res.text();
  expectTrue('  clean envelope, no stack trace', !txt.includes('at Object') && !txt.includes('node_modules'));
}
{
  const res = await owner.call('GET', '/does-not-exist', { auth });
  expectStatusIn('unknown authenticated-scoped route -> 401/404', res, [401, 404]);
  expectTrue('  request_id in envelope', Boolean(res.json?.error?.request_id));
}
{
  const res = await owner.call('GET', '/api/v2/nope');
  expectStatus('route outside /api/v1 -> 404', res, 404);
}
{
  const res = await owner.call('POST', '/health', { body: {} });
  expectStatusIn('POST /health rejected consistently', res, [401, 403, 404, 405]);
}
{
  const res = await owner.call('GET', '/users', { auth });
  expectTrue(
    'JWT secret never echoed',
    Boolean(JWT_SECRET) && !res.text.includes(JWT_SECRET),
    JWT_SECRET ? 'secret was echoed' : 'could not read JWT_ACCESS_SECRET from .env',
  );
}

// --- J. Role gate (support account) ---------------------------------------
section('J. ROLE GATE (throwaway support account)');
{
  // Provision via the CLI — the only path by which an admin can exist.
  // Idempotent: if the account already exists (a previous sweep run created it
  // and rotated its password), reset it with the set-admin-password CLI, which
  // also revokes every session for that account.
  const email = SUPPORT_EMAIL;
  const createScript = fileURLToPath(new URL('./create-admin.js', import.meta.url));
  const resetScript = fileURLToPath(new URL('./set-admin-password.js', import.meta.url));
  let provisioned = false;
  let reset = false;
  try {
    execFileSync(process.execPath, [createScript, '--email', email, '--name', 'Sweep Support', '--role', 'support'], {
      env: { ...process.env, ADMIN_PASSWORD: SUPPORT_PASSWORD },
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    provisioned = true;
  } catch {
    try {
      execFileSync(process.execPath, [resetScript, '--email', email], {
        env: { ...process.env, ADMIN_PASSWORD: SUPPORT_PASSWORD },
        stdio: ['ignore', 'ignore', 'ignore'],
      });
      reset = true;
    } catch (err) {
      expectTrue('support account available (created or reset)', false, err.message);
    }
  }
  expectTrue(
    'support account available (created or reset)',
    provisioned || reset,
    provisioned ? 'created' : 'password reset',
  );

  const support = makeClient();
  const login = await loginAs(support, SUPPORT_EMAIL, SUPPORT_PASSWORD);
  expectStatus('support login -> 200', login, 200);
  const sAuth = { bearer: login.json?.data?.access_token, csrf: login.json?.data?.csrf_token };

  const read = await support.call('GET', '/payment-methods?per_page=1', { auth: sAuth });
  expectStatus('support can READ payment methods', read, 200);

  const write = await support.call('POST', '/payment-methods', { body: { name: 'Support Attempt', type: 'crypto', used_for: 'both' }, auth: sAuth });
  expectStatus('support cannot WRITE -> 403', write, 403);
  expectTrue('  code FORBIDDEN', write.json?.error?.code === 'FORBIDDEN');

  const audit = await support.call('GET', '/audit-log?per_page=1', { auth: sAuth });
  expectStatus('support cannot read audit log -> 403', audit, 403);

  // change-password revokes the refresh session
  const changed = await support.call('POST', '/auth/change-password', {
    body: { current_password: SUPPORT_PASSWORD, new_password: 'Sw33p!Support#2026y' },
    auth: sAuth,
  });
  expectStatus('change-password -> 200', changed, 200);
  expectTrue('  sessions_revoked true', changed.json?.data?.sessions_revoked === true);
  const refresh = await support.call('POST', '/auth/refresh', { auth: { csrf: sAuth.csrf } });
  expectStatus('  old refresh session refused -> 401', refresh, 401);

  // logout-all
  const relogin = await loginAs(support, SUPPORT_EMAIL, 'Sw33p!Support#2026y');
  expectStatus('re-login with new password -> 200', relogin, 200);
  const sAuth2 = { bearer: relogin.json?.data?.access_token, csrf: relogin.json?.data?.csrf_token };
  const out = await support.call('POST', '/auth/logout-all', { auth: sAuth2 });
  expectStatus('logout-all -> 200', out, 200);
  expectTrue('  revoked_sessions >= 1', (out.json?.data?.revoked_sessions ?? 0) >= 1);
  const blocked = await support.call('POST', '/auth/refresh', { auth: { csrf: sAuth2.csrf } });
  expectStatus('  refresh after logout-all -> 401', blocked, 401);

  // leave the account inert
  const revokeScript = fileURLToPath(new URL('./revoke-sessions.js', import.meta.url));
  try {
    execFileSync(process.execPath, [revokeScript, '--email', SUPPORT_EMAIL, '--reason', 'sweep complete'], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    expectTrue('CLI revokes all support sessions', true);
  } catch (err) {
    expectTrue('CLI revokes all support sessions', false, err.message);
  }

  // RESTORE the original password. The change-password test above rotated it
  // permanently, and leaving it rotated broke every later run of
  // frontend/verify.mjs — which signs in as this same account with the
  // original password. A sweep must leave the system as it found it.
  const restoreScript = fileURLToPath(new URL('./set-admin-password.js', import.meta.url));
  try {
    execFileSync(process.execPath, [restoreScript, '--email', SUPPORT_EMAIL], {
      env: { ...process.env, ADMIN_PASSWORD: SUPPORT_PASSWORD },
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    expectTrue('sweep restores the support password it rotated', true);
  } catch (err) {
    expectTrue('sweep restores the support password it rotated', false, err.message);
  }
}

// --- K. Health while authenticated ----------------------------------------
section('K. HEALTH AS AN ADMIN');
{
  const res = await owner.call('GET', '/health', { auth });
  expectStatus('GET /health with bearer -> 200', res, 200);
  expectTrue('authenticated_as populated', res.json?.data?.authenticated_as?.email === OWNER_EMAIL);
}

console.log(`\n=== SWEEP COMPLETE: ${pass} passed, ${fail} failed ===`);
if (failures.length > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
process.exit(0);
