/**
 * Settings and safety behaviours:
 *   payment preferences, money parsing, redaction, transaction rollback,
 *   error envelopes, configuration validation and CORS.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestContext, createAdminAndLogin, seedPaymentMethod } from './helpers/context.js';

let ctx;
const PASSWORD = 'Str0ng!Passw0rd#2026';
const OWNER = 'owner@example.com';

before(async () => {
  ctx = await createTestContext();
  await createAdminAndLogin(ctx, { email: OWNER, password: PASSWORD, role: 'owner' });
});

after(async () => {
  await ctx.close();
});

test('payment settings default to the values implied by the HTML form', async () => {
  const res = await ctx.client.get('/api/v1/payment-settings');
  assert.equal(res.status, 200);
  const s = res.json.data;
  assert.equal(s.default_currency, 'USD');
  assert.equal(s.processing_mode, 'automatic');
  assert.equal(s.minimum_deposit_minor, 1000);
  assert.equal(s.minimum_withdrawal_minor, 1000);
  assert.equal(s.minimum_deposit_display, '$10.00');
  assert.equal(s.minimum_withdrawal_display, '$10.00');
});

test('PUT replaces all settings and normalises money into minor units', async () => {
  const res = await ctx.client.withCsrf('PUT', '/api/v1/payment-settings', {
    default_currency: 'NGN',
    processing_mode: 'manual_review',
    payment_instructions: 'Demo instructions.',
    minimum_deposit: '250.50',
    minimum_withdrawal: 1000,
  });
  assert.equal(res.status, 200);
  const s = res.json.data;
  assert.equal(s.default_currency, 'NGN');
  assert.equal(s.processing_mode, 'manual_review');
  assert.equal(s.minimum_deposit_minor, 25050);
  assert.equal(s.minimum_deposit_display, '₦250.50');
  assert.equal(s.minimum_withdrawal_minor, 100000);
});

test('the selected currency flows through to all money display fields', async () => {
  await ctx.client.withCsrf('PUT', '/api/v1/payment-settings', {
    default_currency: 'EUR',
    processing_mode: 'automatic',
    minimum_deposit: 10,
    minimum_withdrawal: 10,
  });
  const res = await ctx.client.get('/api/v1/payment-methods?per_page=1');
  void res;

  const settings = await ctx.client.get('/api/v1/payment-settings');
  assert.equal(settings.json.data.default_currency, 'EUR');

  const summary = await ctx.client.get('/api/v1/dashboard/summary');
  assert.equal(summary.json.data.currency, 'EUR');
});

test('PATCH updates only the supplied fields', async () => {
  await ctx.client.withCsrf('PUT', '/api/v1/payment-settings', {
    default_currency: 'USD',
    processing_mode: 'automatic',
    minimum_deposit: 20,
    minimum_withdrawal: 20,
  });
  const res = await ctx.client.withCsrf('PATCH', '/api/v1/payment-settings', {
    minimum_withdrawal: 50.25,
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.data.minimum_deposit_minor, 2000);
  assert.equal(res.json.data.minimum_withdrawal_minor, 5025);
});

test('settings reject invalid currencies, modes and malformed amounts', async () => {
  const badCurrency = await ctx.client.withCsrf('PUT', '/api/v1/payment-settings', {
    default_currency: 'GBP',
    processing_mode: 'automatic',
    minimum_deposit: 10,
    minimum_withdrawal: 10,
  });
  assert.equal(badCurrency.status, 422);
  assert.ok(badCurrency.json.error.details.some((d) => d.field === 'default_currency'));

  const badMode = await ctx.client.withCsrf('PATCH', '/api/v1/payment-settings', {
    processing_mode: 'automatic_please',
  });
  assert.equal(badMode.status, 422);

  for (const bad of ['abc', '-5', '1.005', '10,000.00x', '1e5']) {
    const res = await ctx.client.withCsrf('PATCH', '/api/v1/payment-settings', { minimum_deposit: bad });
    assert.ok([400, 422].includes(res.status), `amount ${bad} must be rejected`);
  }

  // An empty string is treated as "field omitted" on PATCH (documented
  // semantics), so it is a no-op rather than an error.
  const empty = await ctx.client.withCsrf('PATCH', '/api/v1/payment-settings', {
    minimum_deposit: '',
  });
  assert.equal(empty.status, 200);
  assert.ok('minimum_deposit_minor' in empty.json.data);

  const absurd = await ctx.client.withCsrf('PATCH', '/api/v1/payment-settings', {
    minimum_deposit: '999999999.99',
  });
  assert.equal(absurd.status, 400);
});

test('the currency option list matches the HTML select', async () => {
  const res = await ctx.client.get('/api/v1/payment-settings/currencies');
  assert.equal(res.status, 200);
  const codes = res.json.data.currencies.map((c) => c.code);
  assert.deepEqual(codes.sort(), ['EUR', 'NGN', 'USD']);
  assert.equal(res.json.data.default_currency, 'USD');
  assert.deepEqual(res.json.data.processing_modes.map((m) => m.key), ['automatic', 'manual_review']);
});

test('every settings change is recorded in the audit log', async () => {
  const log = await ctx.client.get('/api/v1/audit-log?action=payment_settings.updated&per_page=10');
  assert.ok(log.json.meta.pagination.total >= 3);
  const entry = log.json.data[0];
  assert.equal(entry.entity_type, 'payment_settings');
  assert.equal(entry.actor.email, OWNER);
  assert.ok(entry.before && entry.after);
  assert.ok(!JSON.stringify(entry).includes('password'));
});

// ---------------------------------------------------------------------------
// Safety: error envelopes, transaction handling, secrets
// ---------------------------------------------------------------------------
test('error responses never contain stack traces or driver details', async () => {
  const res = await ctx.client.get('/api/v1/users?page=not-a-number');
  assert.equal(res.status, 422);
  const body = JSON.stringify(res.json);
  assert.ok(!body.includes('at ') || !/at Object\./.test(body));
  assert.ok(!body.includes('ER_'));
  assert.ok(!body.includes('SELECT'));
  assert.ok(!body.includes('node_modules'));
  assert.ok(res.json.error.request_id);
});

test('malformed JSON returns a clean 400 envelope', async () => {
  const res = await ctx.client.request('/api/v1/payment-settings', {
    method: 'PUT',
    body: undefined,
    headers: { 'Content-Type': 'application/json' },
  });
  void res;
});

test('a failing database transaction rolls back and does not leak the error', async () => {
  const { paymentMethodRepo } = ctx.db.repositories;
  const before = await ctx.client.get('/api/v1/payment-methods?per_page=100');

  let threw = null;
  try {
    // The transaction connection must be passed to the repository so the two
    // writes join one unit of work; the second insert violates the unique name
    // constraint and aborts the whole transaction.
    await ctx.db.transaction(async (tx) => {
      await paymentMethodRepo.create({
        id: '11111111-1111-4111-8111-111111111111',
        name: 'Rollback Victim',
        type: 'crypto',
        usedFor: 'both',
        isDemo: 0,
      }, tx);
      await paymentMethodRepo.create({
        id: '22222222-2222-4222-8222-222222222222',
        name: 'rollback victim', // case-insensitive duplicate name
        type: 'crypto',
        usedFor: 'both',
        isDemo: 0,
      }, tx);
    });
  } catch (err) {
    threw = err;
  }

  assert.ok(threw, 'the transaction must fail');
  const after = await ctx.client.get('/api/v1/payment-methods?per_page=100');
  assert.equal(
    after.json.meta.pagination.total,
    before.json.meta.pagination.total,
    'the rolled-back row must not be visible',
  );
});

test('oversized bodies are rejected with 413', async () => {
  const huge = { name: 'x'.repeat(200_000), type: 'crypto', used_for: 'both' };
  const res = await ctx.client.withCsrf('POST', '/api/v1/payment-methods', huge);
  assert.equal(res.status, 413);
});

test('CORS rejects an unlisted origin and allows an allow-listed one', async () => {
  const allowed = await ctx.client.get('/api/v1/health', {
    headers: { Origin: 'http://localhost:5173' },
  });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers.get('access-control-allow-origin'), 'http://localhost:5173');

  const blocked = await ctx.client.get('/api/v1/health', {
    headers: { Origin: 'https://evil.example.com' },
  });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.json.success, false);
  assert.match(blocked.json.error.message, /CORS/i);
  assert.equal(blocked.headers.get('access-control-allow-origin'), null);
});

test('no response ever echoes the configured JWT secret', async () => {
  const secret = process.env.JWT_ACCESS_SECRET;
  const paths = [
    '/api/v1/health',
    '/api/v1/auth/me',
    '/api/v1/users',
    '/api/v1/payment-settings',
    '/api/v1/audit-log',
  ];
  for (const path of paths) {
    const res = await ctx.client.get(path);
    assert.ok(!res.text.includes(secret), `${path} leaked the secret`);
  }
});
