/**
 * Login ACCOUNT LOCKOUT (423).
 *
 * `env` is a process-wide singleton (one config per process), so this file owns
 * exactly one configuration: the lockout is set low and the RATE LIMITER is set
 * far out of the way, isolating the lockout's behaviour. The limiter itself is
 * covered by tests/auth-rate-limit.test.js.
 *
 * The lockout is persisted on the account (admins.failed_login_count /
 * customer_auth.failed_login_count) and lasts LOGIN_LOCKOUT_MINUTES, so it
 * survives the request that tripped it and refuses even a correct password
 * until it expires. That is the property under test.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestContext, createAdminAndLogin } from './helpers/context.js';

const PASSWORD = 'Str0ng!Passw0rd#2026';

let ctx;
let lockEmail;

before(async () => {
  ctx = await createTestContext({
    // Limiter far out of the way so only the lockout can fire.
    RATE_LIMIT_LOGIN_MAX: '1000',
    LOGIN_MAX_ATTEMPTS: '3',
    LOGIN_LOCKOUT_MINUTES: '15',
  });
  lockEmail = `locked-${Date.now()}@example.com`;
  await createAdminAndLogin(ctx, { email: lockEmail, password: PASSWORD });
});

after(async () => {
  await ctx.close();
});

test('the third failed attempt trips the lockout with 423', async () => {
  let last = null;
  for (let i = 0; i < 3; i += 1) {
    last = await ctx.client.post('/api/v1/auth/login', {
      email: lockEmail,
      password: 'wrong-password-here',
    });
  }
  assert.equal(last.status, 423, 'the third failure must trip the lockout');
  assert.equal(last.json.error.code, 'ACCOUNT_LOCKED');
  assert.ok(last.json.error.details?.locked_until, 'the response says when it expires');
});

test('the CORRECT password is refused while the account is locked', async () => {
  const refused = await ctx.client.post('/api/v1/auth/login', {
    email: lockEmail,
    password: PASSWORD,
  });
  assert.equal(refused.status, 423);
  assert.equal(refused.json.error.code, 'ACCOUNT_LOCKED');
});

test('a different account is not locked by this one', async () => {
  const otherEmail = `unlocked-${Date.now()}@example.com`;
  await createAdminAndLogin(ctx, { email: otherEmail, password: PASSWORD });

  const res = await ctx.client.post('/api/v1/auth/login', {
    email: otherEmail,
    password: PASSWORD,
  });
  assert.equal(res.status, 200, 'only the account that failed is locked');
});

test('locked-out attempts are still audited, without credentials', async () => {
  // One more failure while already locked, to generate an audit entry.
  await ctx.client.post('/api/v1/auth/login', { email: lockEmail, password: 'nope' });

  const res = await ctx.client.get('/api/v1/audit-log?action=auth.login_failed&per_page=10');
  assert.ok(res.json.meta.pagination.total >= 1);
  const body = JSON.stringify(res.json).toLowerCase();
  for (const needle of ['nope', 'password_hash', 'token']) {
    assert.ok(!body.includes(needle), `audit entries must not contain "${needle}"`);
  }
});
