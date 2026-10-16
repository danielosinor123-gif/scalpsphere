/**
 * Login RATE LIMITING (429).
 *
 * `env` is a process-wide singleton (one config per process), so this file owns
 * exactly one configuration: the limiter is set low and the ACCOUNT LOCKOUT is
 * set high, isolating the limiter's behaviour.
 *
 * Measured semantics of express-rate-limit used here, verified empirically:
 *   max: 3  ->  requests 1..3 are processed; request 4 is the FIRST blocked.
 *   `skipSuccessfulRequests: true`  ->  successes never count.
 *   key = IP + submitted email      ->  another account's window never blocks you.
 *
 * Because the limiter runs in MIDDLEWARE it also defines the precedence: when
 * the limiter's threshold is lower than the account lockout's, the lockout is
 * never reached. When the two are equal the lockout wins, because it trips on
 * the Nth failure inside the handler while the limiter only blocks from N+1.
 * The lockout itself is covered by tests/auth-lockout.test.js.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestContext, createAdminAndLogin } from './helpers/context.js';

const PASSWORD = 'Str0ng!Passw0rd#2026';

let ctx;

before(async () => {
  ctx = await createTestContext({
    RATE_LIMIT_LOGIN_MAX: '3',
    RATE_LIMIT_LOGIN_WINDOW_MS: '600000',
    // Lockout far out of the way so only the limiter can fire.
    LOGIN_MAX_ATTEMPTS: '50',
  });
});

after(async () => {
  await ctx.close();
});

test('successful logins never count against the limit', async () => {
  const email = `successes-${Date.now()}@example.com`;
  await createAdminAndLogin(ctx, { email, password: PASSWORD });

  for (let i = 0; i < 3; i += 1) {
    const res = await ctx.client.post('/api/v1/auth/login', { email, password: PASSWORD });
    assert.equal(res.status, 200, `login ${i + 1} should succeed`);
  }
  // If successes were being counted, this failure would already be 429.
  const failure = await ctx.client.post('/api/v1/auth/login', {
    email,
    password: 'wrong-password',
  });
  assert.equal(failure.status, 401, 'successes must not consume the failure budget');
});

test('with max=3 the FOURTH failed attempt is the first refused', async () => {
  // A non-existent account is enough: the limiter is keyed on the submitted
  // email and runs in middleware, before the account is even looked up.
  const email = `fourth-${Date.now()}@example.com`;

  for (let i = 1; i <= 3; i += 1) {
    const res = await ctx.client.post('/api/v1/auth/login', {
      email,
      password: 'wrong-password',
    });
    assert.equal(res.status, 401, `attempt ${i} must be processed by the handler`);
  }

  const blocked = await ctx.client.post('/api/v1/auth/login', {
    email,
    password: 'wrong-password',
  });
  assert.equal(blocked.status, 429);
  assert.equal(blocked.json.error.code, 'RATE_LIMITED');
});

test('a CORRECT password is refused while the window is exhausted', async () => {
  const email = `correct-${Date.now()}@example.com`;
  await createAdminAndLogin(ctx, { email, password: PASSWORD });

  for (let i = 0; i < 3; i += 1) {
    await ctx.client.post('/api/v1/auth/login', { email, password: 'wrong-password' });
  }
  const refused = await ctx.client.post('/api/v1/auth/login', { email, password: PASSWORD });
  assert.equal(refused.status, 429);
});

test('one account\'s exhausted window never blocks a different email', async () => {
  const email = `isolated-${Date.now()}@example.com`;
  await createAdminAndLogin(ctx, { email, password: PASSWORD });

  for (let i = 0; i < 4; i += 1) {
    await ctx.client.post('/api/v1/auth/login', { email, password: 'wrong-password' });
  }
  assert.equal(
    (await ctx.client.post('/api/v1/auth/login', { email, password: 'wrong-password' })).status,
    429,
    'sanity: the window is exhausted',
  );

  const other = await ctx.client.post('/api/v1/auth/login', {
    email: `unrelated-${Date.now()}@example.com`,
    password: 'wrong-password',
  });
  assert.equal(other.status, 401, 'the limiter key includes the email');
});

test('a failed login is audited without revealing the password', async () => {
  const email = `audited-${Date.now()}@example.com`;
  await createAdminAndLogin(ctx, { email, password: PASSWORD });
  await ctx.client.post('/api/v1/auth/login', { email, password: 'wrong-password' });

  const res = await ctx.client.get('/api/v1/audit-log?action=auth.login_failed&per_page=10');
  assert.ok(res.json.meta.pagination.total >= 1);
  const entry = res.json.data[0];
  assert.equal(entry.entity_type, 'admin');
  assert.match(entry.summary, /Failed sign-in attempt/);
  const body = JSON.stringify(entry).toLowerCase();
  for (const needle of ['wrong-password', 'password_hash', 'token']) {
    assert.ok(!body.includes(needle), `audit entry must not contain "${needle}"`);
  }
});
