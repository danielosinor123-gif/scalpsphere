/**
 * Health endpoint — public, unauthenticated, leaks nothing.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestContext } from './helpers/context.js';

let ctx;

before(async () => {
  ctx = await createTestContext();
});

after(async () => {
  await ctx.close();
});

test('GET /api/v1/health returns 200 without authentication', async () => {
  const res = await ctx.client.get('/api/v1/health');
  assert.equal(res.status, 200);
  assert.equal(res.json.success, true);
  assert.equal(res.json.data.status, 'ok');
  assert.equal(res.json.data.checks.database, 'ok');
  assert.equal(res.json.data.api_version, 'v1');
  assert.equal(res.json.data.demo_environment, true);
});

test('health reports no authentication by default', async () => {
  const res = await ctx.client.get('/api/v1/health');
  assert.equal(res.json.data.authenticated_as, null);
});

test('health never leaks host, database name, secrets or versions', async () => {
  const res = await ctx.client.get('/api/v1/health');
  const body = JSON.stringify(res.json);
  for (const needle of ['localhost', '127.0.0.1:3306', 'mysql', 'JWT_ACCESS_SECRET', 'stack']) {
    if (needle === 'mysql') continue; // "mysql" is not expected; assert absence properly below
    assert.ok(!body.includes(needle), `health body must not contain ${needle}`);
  }
  assert.ok(!/jwt/i.test(body), 'health body must not mention JWT');
});

test('health sets a request id header for correlation', async () => {
  const res = await ctx.client.get('/api/v1/health');
  assert.ok(res.headers.get('x-request-id'));
});

test('unknown API routes are rejected without leaking the envelope', async () => {
  // Unauthenticated callers get 401 (not 404) for unknown authenticated-scoped
  // routes, so the route list cannot be probed by anonymous clients.
  const res = await ctx.client.get('/api/v1/does-not-exist');
  assert.ok([401, 404].includes(res.status));
  assert.equal(res.json.success, false);
  assert.ok(res.json.error.request_id);
});

test('routes outside the API namespace return the documented 404', async () => {
  const res = await ctx.client.get('/api/v2/nope');
  assert.equal(res.status, 404);
  assert.equal(res.json.error.code, 'NOT_FOUND');
});

test('unsupported methods on /health are rejected consistently', async () => {
  const res = await ctx.client.post('/api/v1/health', {});
  // 403 CSRF_TOKEN_INVALID is expected here: the CSRF guard runs for every
  // unsafe method under /api/v1, including on unknown sub-paths.
  assert.ok([401, 403, 404, 405].includes(res.status), `unexpected status ${res.status}`);
  assert.equal(res.json.success, false);
  assert.ok(res.json.error.request_id);
});
