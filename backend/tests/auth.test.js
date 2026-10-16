/**
 * Authentication: login, refresh rotation, logout, session introspection,
 * CSRF enforcement, lockout and password policy.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestContext, createAdminAndLogin } from './helpers/context.js';

let ctx;
const PASSWORD = 'Str0ng!Passw0rd#2026';
const EMAIL = 'owner@example.com';

before(async () => {
  ctx = await createTestContext();
});

after(async () => {
  await ctx.close();
});

test('login succeeds and returns an access token plus httpOnly cookies', async () => {
  const { admin } = await createAdminAndLogin(ctx, { email: EMAIL, password: PASSWORD });
  assert.ok(admin);

  const res = await ctx.client.post('/api/v1/auth/login', { email: EMAIL, password: PASSWORD });
  assert.equal(res.status, 200);
  assert.equal(res.json.success, true);
  assert.ok(res.json.data.access_token);
  assert.equal(res.json.data.token_type, 'Bearer');
  assert.ok(res.json.data.csrf_token);
  assert.ok(res.json.data.session_expires_at);

  // No sensitive material in the response body.
  assert.ok(!JSON.stringify(res.json).includes(PASSWORD));

  const cookies = res.setCookies.join(' ');
  assert.match(cookies, /access_token=/);
  assert.match(cookies, /HttpOnly/i);
  assert.match(cookies, /refresh_token=/);
});

test('login fails with 401 for an unknown account', async () => {
  const res = await ctx.client.post('/api/v1/auth/login', {
    email: 'nobody@example.com',
    password: 'whatever-password',
  });
  assert.equal(res.status, 401);
  assert.equal(res.json.error.code, 'INVALID_CREDENTIALS');
  assert.ok(!/nobody/.test(JSON.stringify(res.json)), 'must not confirm account existence');
});

test('login fails with 401 for a wrong password', async () => {
  const res = await ctx.client.post('/api/v1/auth/login', { email: EMAIL, password: 'wrong-password-1' });
  assert.equal(res.status, 401);
  assert.equal(res.json.error.code, 'INVALID_CREDENTIALS');
});

test('login rejects a malformed email with 422 and field details', async () => {
  const res = await ctx.client.post('/api/v1/auth/login', { email: 'not-an-email', password: 'x' });
  assert.equal(res.status, 422);
  assert.equal(res.json.error.code, 'VALIDATION_ERROR');
  assert.ok(Array.isArray(res.json.error.details));
  assert.ok(res.json.error.details.some((d) => d.field === 'email'));
});

test('login rejects unknown fields with 422', async () => {
  const res = await ctx.client.post('/api/v1/auth/login', {
    email: EMAIL,
    password: PASSWORD,
    is_admin: true,
  });
  assert.equal(res.status, 422);
  assert.ok(res.json.error.details.some((d) => d.field === 'is_admin'));
});

test('all admin endpoints reject unauthenticated requests with 401', async () => {
  // Drop any session left by an earlier test in this file.
  ctx.client.clearCookies();
  for (const path of [
    '/api/v1/dashboard/summary',
    '/api/v1/users',
    '/api/v1/users/recent',
    '/api/v1/withdrawals',
    '/api/v1/payment-methods',
    '/api/v1/payment-settings',
    '/api/v1/audit-log',
  ]) {
    const res = await ctx.client.get(path);
    assert.equal(res.status, 401, `${path} must require authentication`);
    assert.equal(res.json.error.code, 'UNAUTHENTICATED');
  }
});

test('a tampered access token is rejected', async () => {
  const res = await ctx.client.get('/api/v1/users', {
    headers: { Authorization: 'Bearer not.a.real.token' },
  });
  assert.equal(res.status, 401);
  assert.equal(res.json.error.code, 'UNAUTHENTICATED');
});

test('write endpoints require a CSRF header when cookie-authenticated', async () => {
  const login = await ctx.client.post('/api/v1/auth/login', { email: EMAIL, password: PASSWORD });
  const csrf = login.json.data.csrf_token;

  // Missing X-CSRF-Token → 403 CSRF_TOKEN_INVALID
  const without = await ctx.client.request('/api/v1/payment-methods', {
    method: 'POST',
    body: { name: 'No CSRF', type: 'crypto', used_for: 'both' },
  });
  assert.equal(without.status, 403);
  assert.equal(without.json.error.code, 'CSRF_TOKEN_INVALID');

  // Wrong token → 403
  const wrong = await ctx.client.request('/api/v1/payment-methods', {
    method: 'POST',
    headers: { 'X-CSRF-Token': 'deadbeefdeadbeefdeadbeefdeadbeef' },
    body: { name: 'Wrong CSRF', type: 'crypto', used_for: 'both' },
  });
  assert.equal(wrong.status, 403);

  // Correct token → 201
  const good = await ctx.client.request('/api/v1/payment-methods', {
    method: 'POST',
    headers: { 'X-CSRF-Token': csrf },
    body: { name: 'With CSRF', type: 'crypto', used_for: 'both' },
  });
  assert.equal(good.status, 201);
});

test('GET /api/v1/auth/me returns the authenticated principal', async () => {
  const login = await ctx.client.post('/api/v1/auth/login', { email: EMAIL, password: PASSWORD });
  assert.equal(login.status, 200);
  const res = await ctx.client.get('/api/v1/auth/me');
  assert.equal(res.status, 200);
  assert.equal(res.json.data.email, EMAIL);
  assert.equal(res.json.data.role, 'owner');
});

test('logout clears the session and blocks reuse of the refresh cookie', async () => {
  const login = await ctx.client.post('/api/v1/auth/login', { email: EMAIL, password: PASSWORD });
  assert.equal(login.status, 200);
  const csrf = login.json.data.csrf_token;
  const oldRefresh = ctx.client.cookies.get('refresh_token')?.value;

  const me = await ctx.client.get('/api/v1/auth/me');
  assert.equal(me.status, 200);

  const out = await ctx.client.request('/api/v1/auth/logout', {
    method: 'POST',
    headers: { 'X-CSRF-Token': csrf },
  });
  assert.equal(out.status, 200);

  const after = await ctx.client.get('/api/v1/auth/me');
  assert.equal(after.status, 401);

  // Replaying the revoked refresh cookie must fail.
  assert.ok(oldRefresh);
  ctx.client.cookies.set('refresh_token', { value: oldRefresh, httpOnly: true });
  ctx.client.cookies.set('csrf_token', { value: csrf, httpOnly: false });
  const refresh = await ctx.client.request('/api/v1/auth/refresh', {
    method: 'POST',
    headers: { 'X-CSRF-Token': csrf },
  });
  assert.equal(refresh.status, 401, 'the revoked refresh token must be refused');
});

test('refresh rotates the refresh token and revokes the previous one', async () => {
  await ctx.client.clearCookies();
  const login = await ctx.client.post('/api/v1/auth/login', { email: EMAIL, password: PASSWORD });
  assert.equal(login.status, 200);
  const oldRefresh = ctx.client.cookies.get('refresh_token')?.value;

  const refreshed = await ctx.client.request('/api/v1/auth/refresh', {
    method: 'POST',
    headers: { 'X-CSRF-Token': login.json.data.csrf_token },
  });
  assert.equal(refreshed.status, 200);
  const newRefresh = ctx.client.cookies.get('refresh_token')?.value;
  assert.notEqual(oldRefresh, newRefresh, 'the refresh token must be rotated');
  assert.ok(newRefresh);

  const me = await ctx.client.get('/api/v1/auth/me');
  assert.equal(me.status, 200);
});

test('change-password requires the current password and revokes sessions', async () => {
  const fresh = 'fresh@example.com';
  const { admin } = await createAdminAndLogin(ctx, {
    email: fresh,
    password: 'Sup3rStr0ng!Pass#1',
    role: 'admin',
  });
  assert.ok(admin);

  const login = await ctx.client.post('/api/v1/auth/login', {
    email: fresh,
    password: 'Sup3rStr0ng!Pass#1',
  });
  const csrf = login.json.data.csrf_token;

  const wrong = await ctx.client.request('/api/v1/auth/change-password', {
    method: 'POST',
    headers: { 'X-CSRF-Token': csrf },
    body: { current_password: 'nope', new_password: 'An0ther!Str0ng#Pass' },
  });
  assert.equal(wrong.status, 400);

  const weak = await ctx.client.request('/api/v1/auth/change-password', {
    method: 'POST',
    headers: { 'X-CSRF-Token': csrf },
    body: { current_password: 'Sup3rStr0ng!Pass#1', new_password: 'short' },
  });
  assert.equal(weak.status, 422);

  const changed = await ctx.client.request('/api/v1/auth/change-password', {
    method: 'POST',
    headers: { 'X-CSRF-Token': csrf },
    body: { current_password: 'Sup3rStr0ng!Pass#1', new_password: 'An0ther!Str0ng#Pass' },
  });
  assert.equal(changed.status, 200);
  assert.equal(changed.json.data.password_changed, true);
  assert.equal(changed.json.data.sessions_revoked, true);

  // Note: the already-issued access token is a stateless JWT and stays valid
  // until JWT_ACCESS_TTL expires (15m by default). What a password change
  // guarantees is that the *refresh* session is revoked, so the attacker's
  // session cannot be extended. That is asserted here.
  const refreshBlocked = await ctx.client.request('/api/v1/auth/refresh', {
    method: 'POST',
    headers: { 'X-CSRF-Token': csrf },
  });
  assert.equal(refreshBlocked.status, 401, 'the revoked refresh session cannot be reused');

  const loginAgain = await ctx.client.post('/api/v1/auth/login', {
    email: fresh,
    password: 'An0ther!Str0ng#Pass',
  });
  assert.equal(loginAgain.status, 200);
});

test('the password hash is never returned by any response', async () => {
  const { login } = await createAdminAndLogin(ctx, { email: 'hashcheck@example.com' });
  assert.ok(login.status === 200);
  const res = await ctx.client.get('/api/v1/auth/me');
  const body = JSON.stringify(res.json);
  assert.ok(!body.includes('password_hash'));
  assert.ok(!body.includes('$2y$') && !body.includes('$2b$') && !body.includes('$2a$'));
});
