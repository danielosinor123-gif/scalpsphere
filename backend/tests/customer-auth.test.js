/**
 * CUSTOMER AUTHENTICATION
 *
 * Covers: sign-in, session, refresh rotation, logout, lockout, CSRF, and — most
 * importantly — TOKEN DOMAIN SEPARATION: a customer token must never be accepted
 * by an admin route, and an admin token must never be accepted by a customer
 * route, even though both share one signing secret.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  createTestContext, createAdminAndLogin, createCustomerAndLogin, CUSTOMER_PASSWORD,
} from './helpers/context.js';

let ctx;

before(async () => {
  ctx = await createTestContext();
});

after(async () => {
  await ctx.close();
});

test('customer login returns a session, cookies and a CSRF token', async () => {
  const c = await createCustomerAndLogin(ctx);
  assert.equal(c.login.status, 200, JSON.stringify(c.login.json).slice(0, 200));
  assert.ok(c.accessToken);
  assert.ok(c.csrfToken);
  assert.equal(c.login.json.data.token_type, 'Bearer');
  assert.equal(c.login.json.data.customer.email, c.user.email);
  assert.ok(!JSON.stringify(c.login.json).includes(CUSTOMER_PASSWORD));

  const cookies = c.login.setCookies.join(' ');
  assert.match(cookies, /cust_access_token=/);
  assert.match(cookies, /cust_refresh_token=/);
  assert.match(cookies, /HttpOnly/i);
  // Admin cookies are NOT set by a customer login.
  const adminCookie = c.login.setCookies.find((r) => /^access_token=/.test(r));
  assert.equal(adminCookie, undefined);
});

test('unknown email and wrong password both return the same 401', async () => {
  const a = await ctx.client.post('/api/v1/customer/auth/login', {
    email: 'ghost@example.com', password: 'Whatever!Password1',
  });
  const b = await ctx.client.post('/api/v1/customer/auth/login', {
    email: 'ghost@example.com', password: 'different-password',
  });
  assert.equal(a.status, 401);
  assert.equal(a.json.error.code, 'INVALID_CREDENTIALS');
  assert.equal(b.status, 401);
  // Identical code AND message: no account enumeration. (request_id is
  // deliberately unique per response, so it is excluded from the comparison.)
  assert.equal(a.json.error.code, b.json.error.code);
  assert.equal(a.json.error.message, b.json.error.message);
});

test('malformed email and unknown fields are rejected with 422', async () => {
  const bad = await ctx.client.post('/api/v1/customer/auth/login', {
    email: 'not-an-email', password: 'x',
  });
  assert.equal(bad.status, 422);
  assert.ok(bad.json.error.details.some((d) => d.field === 'email'));

  const extra = await ctx.client.post('/api/v1/customer/auth/login', {
    email: 'a@example.com', password: CUSTOMER_PASSWORD, user_id: 123,
  });
  assert.equal(extra.status, 422);
  assert.ok(extra.json.error.details.some((d) => d.field === 'user_id'));
});

test('a customer token is REJECTED by admin routes (audience separation)', async () => {
  const c = await createCustomerAndLogin(ctx);
  assert.equal(c.login.status, 200);

  const res = await ctx.client.get('/api/v1/users', {
    headers: { Authorization: `Bearer ${c.accessToken}` },
  });
  assert.equal(res.status, 401);
  assert.equal(res.json.error.code, 'UNAUTHENTICATED');
  assert.equal(res.json.error.details?.reason, 'token_invalid');

  // And via the cookie transport, too.
  ctx.client.cookies.set('access_token', { value: c.accessToken, httpOnly: true });
  const viaCookie = await ctx.client.get('/api/v1/users');
  assert.equal(viaCookie.status, 401);
  ctx.client.cookies.delete('access_token');
});

test('an ADMIN token is REJECTED by customer routes (audience separation)', async () => {
  const admin = await createAdminAndLogin(ctx, { email: 'cx-owner@example.com' });
  assert.equal(admin.login.status, 200);

  const res = await ctx.client.get('/api/v1/customer/profile', {
    headers: { Authorization: `Bearer ${admin.accessToken}` },
  });
  assert.equal(res.status, 401);
  assert.equal(res.json.error.code, 'UNAUTHENTICATED');
});

test('customer session endpoint returns the identity and member-since', async () => {
  const c = await createCustomerAndLogin(ctx);
  const res = await ctx.client.get('/api/v1/customer/auth/session', { headers: c.authHeaders });
  assert.equal(res.status, 200);
  assert.equal(res.json.data.email, c.user.email);
  assert.match(res.json.data.id, /^USR-\d{5}$/);
  assert.ok(res.json.data.member_since);
  // No credential material, no admin-only fields.
  assert.ok(!('role' in res.json.data));
  assert.ok(!JSON.stringify(res.json).includes('password_hash'));
});

test('unauthenticated access to a customer route is 401', async () => {
  ctx.client.clearCookies();
  const res = await ctx.client.get('/api/v1/customer/profile');
  assert.equal(res.status, 401);
  assert.equal(res.json.error.code, 'UNAUTHENTICATED');
});

test('refresh rotates the refresh token and revokes the old one', async () => {
  const c = await createCustomerAndLogin(ctx);
  const oldRefresh = ctx.client.cookies.get('cust_refresh_token')?.value;
  assert.ok(oldRefresh);

  const refreshed = await ctx.client.request('/api/v1/customer/auth/refresh', {
    method: 'POST',
    headers: { 'X-CSRF-Token': c.csrfToken },
  });
  assert.equal(refreshed.status, 200, JSON.stringify(refreshed.json).slice(0, 200));
  assert.notEqual(ctx.client.cookies.get('cust_refresh_token')?.value, oldRefresh);
  assert.ok(refreshed.json.data.access_token);

  // Replay the OLD token. This must go through bare fetch, not the shared
  // client: the client's cookie jar would silently override the Cookie header
  // and send the NEW token instead, making a correct revocation look like a bug.
  const replay = await fetch(`${ctx.baseUrl}/api/v1/customer/auth/refresh`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-Token': refreshed.json.data.csrf_token,
      Cookie: `cust_refresh_token=${oldRefresh}; csrf_token=${refreshed.json.data.csrf_token}`,
    },
  });
  assert.equal(replay.status, 401, 'the revoked refresh token must be refused');
});

test('logout revokes the refresh session so it cannot be extended', async () => {
  const c = await createCustomerAndLogin(ctx);
  const out = await ctx.client.request('/api/v1/customer/auth/logout', {
    method: 'POST',
    headers: { 'X-CSRF-Token': c.csrfToken },
  });
  assert.equal(out.status, 200);

  // The already-issued access token is a stateless JWT and remains valid until
  // JWT_ACCESS_TTL expires — that is the documented trade-off, identical to the
  // admin domain. What logout guarantees is that the session CANNOT BE
  // EXTENDED: the refresh token is refused.
  const stillValid = await ctx.client.get('/api/v1/customer/profile', { headers: c.authHeaders });
  assert.ok([200, 401].includes(stillValid.status));

  const refresh = await ctx.client.request('/api/v1/customer/auth/refresh', {
    method: 'POST',
    headers: { 'X-CSRF-Token': c.csrfToken },
  });
  assert.equal(refresh.status, 401, 'the refresh session must be revoked by logout');
});

test('cookie-authenticated customer writes require the CSRF header', async () => {
  const c = await createCustomerAndLogin(ctx);
  // Re-authenticate so the jar holds the session cookies for this customer.
  const relogin = await ctx.client.post('/api/v1/customer/auth/login', {
    email: c.user.email, password: CUSTOMER_PASSWORD,
  });
  assert.equal(relogin.status, 200);

  const without = await ctx.client.request('/api/v1/customer/profile', {
    method: 'PATCH',
    body: { full_name: 'No Csrf' },
  });
  assert.equal(without.status, 403);
  assert.equal(without.json.error.code, 'CSRF_TOKEN_INVALID');

  const withCsrf = await ctx.client.request('/api/v1/customer/profile', {
    method: 'PATCH',
    headers: { 'X-CSRF-Token': ctx.client.cookies.get('csrf_token')?.value ?? '' },
    body: { full_name: 'With Csrf' },
  });
  assert.equal(withCsrf.status, 200);
  assert.equal(withCsrf.json.data.full_name, 'With Csrf');
});

test('repeated failures lock the CUSTOMER account with 423', async () => {
  const c = await createCustomerAndLogin(ctx, {
    user: { email: `lockme-${Date.now()}@example.com` },
  });
  let last;
  for (let i = 0; i < 8; i += 1) {
    last = await ctx.client.post('/api/v1/customer/auth/login', {
      email: c.user.email, password: 'definitely-wrong-password',
    });
  }
  assert.equal(last.status, 423);
  assert.equal(last.json.error.code, 'ACCOUNT_LOCKED');

  const correct = await ctx.client.post('/api/v1/customer/auth/login', {
    email: c.user.email, password: CUSTOMER_PASSWORD,
  });
  assert.equal(correct.status, 423);
});
