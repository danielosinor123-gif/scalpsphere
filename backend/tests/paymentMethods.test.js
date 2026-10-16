/**
 * Payment methods: the ONLY write surface. Covers create / read / update /
 * enable / disable / delete, the audit trail, conflict handling, validation,
 * role restrictions and transaction rollback.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestContext, createAdminAndLogin, seedPaymentMethod } from './helpers/context.js';

let ctx;
const PASSWORD = 'Str0ng!Passw0rd#2026';
const OWNER = 'owner@example.com';
const SUPPORT = 'support@example.com';
const SUPPORT_PASSWORD = 'An0ther!Str0ng#Pass';

before(async () => {
  ctx = await createTestContext();
  await createAdminAndLogin(ctx, { email: OWNER, password: PASSWORD });
  await createAdminAndLogin(ctx, {
    email: SUPPORT,
    password: SUPPORT_PASSWORD,
    fullName: 'Support Reader',
    role: 'support',
  });
  // Re-authenticate as the owner after the second login replaced the jar.
  await ctx.client.post('/api/v1/auth/login', { email: OWNER, password: PASSWORD });
  for (const m of [
    { name: 'USDT', type: 'crypto', usedFor: 'both', status: 'enabled' },
    { name: 'Bitcoin', type: 'crypto', usedFor: 'both', status: 'disabled' },
    { name: 'Ethereum', type: 'crypto', usedFor: 'withdraw', status: 'disabled' },
    { name: 'Bank Transfer', type: 'currency', usedFor: 'both', status: 'enabled' },
    { name: 'Paypal', type: 'currency', usedFor: 'deposit', status: 'disabled' },
  ]) {
    await seedPaymentMethod(ctx, m);
  }
});

after(async () => {
  await ctx.close();
});

test('payment methods are seeded and paginated', async () => {
  const res = await ctx.client.get('/api/v1/payment-methods?per_page=2');
  assert.equal(res.status, 200);
  assert.equal(res.json.data.length, 2);
  assert.equal(res.json.meta.pagination.total, 5);
  assert.equal(res.json.meta.paginated ?? res.json.meta.pagination, res.json.meta.pagination);
});

test('payment method rows use the admin.html vocabulary', async () => {
  const res = await ctx.client.get('/api/v1/payment-methods?per_page=1');
  const m = res.json.data[0];
  for (const key of ['id', 'name', 'type', 'used_for', 'status', 'is_demo', 'created_at']) {
    assert.ok(key in m, `missing ${key}`);
  }
  assert.ok(['crypto', 'currency'].includes(m.type));
  assert.ok(['deposit', 'withdraw', 'both'].includes(m.used_for));
  assert.ok(['enabled', 'disabled'].includes(m.status));
});

test('search, type, used_for and status filters work', async () => {
  const search = await ctx.client.get('/api/v1/payment-methods?search=USDT');
  assert.equal(search.json.meta.pagination.total, 1);

  const crypto = await ctx.client.get('/api/v1/payment-methods?type=crypto&per_page=100');
  assert.ok(crypto.json.data.every((m) => m.type === 'crypto'));
  assert.equal(crypto.json.meta.pagination.total, 3);

  const enabled = await ctx.client.get('/api/v1/payment-methods?status=enabled&per_page=100');
  assert.equal(enabled.json.meta.pagination.total, 2);

  const both = await ctx.client.get('/api/v1/payment-methods?used_for=both&per_page=100');
  assert.ok(both.json.data.every((m) => m.used_for === 'both'));
});

test('create validates every field', async () => {
  const cases = [
    { body: { type: 'crypto', used_for: 'both' }, field: 'name' },
    { body: { name: 'X', type: 'crypto', used_for: 'both' }, field: 'name' },
    { body: { name: 'New Method', type: 'stocks', used_for: 'both' }, field: 'type' },
    { body: { name: 'New Method', type: 'crypto', used_for: 'sometimes' }, field: 'used_for' },
    {
      body: { name: 'New Method', type: 'crypto', used_for: 'both', surprise: 1 },
      field: 'surprise',
    },
  ];
  for (const c of cases) {
    const res = await ctx.client.withCsrf('POST', '/api/v1/payment-methods', c.body);
    assert.equal(res.status, 422, JSON.stringify(c.body));
    assert.equal(res.json.error.code, 'VALIDATION_ERROR');
    assert.ok(res.json.error.details.some((d) => d.field === c.field), JSON.stringify(res.json));
  }
});

test('create succeeds and returns 201 with the created row', async () => {
  const res = await ctx.client.withCsrf('POST', '/api/v1/payment-methods', {
    name: 'Solana',
    type: 'crypto',
    used_for: 'both',
    status: 'enabled',
  });
  assert.equal(res.status, 201);
  const m = res.json.data;
  assert.equal(m.name, 'Solana');
  assert.equal(m.type, 'crypto');
  assert.equal(m.used_for, 'both');
  assert.equal(m.status, 'enabled');
  assert.equal(m.is_demo, false, 'admin-created rows are not demo fixtures');
  assert.match(m.id, /^PAY-\d{5}$/);
});

test('create rejects a duplicate name with 409 and a helpful payload', async () => {
  const res = await ctx.client.withCsrf('POST', '/api/v1/payment-methods', {
    name: 'solana', // case-insensitive duplicate
    type: 'crypto',
    used_for: 'both',
  });
  assert.equal(res.status, 409);
  assert.equal(res.json.error.code, 'CONFLICT');
  assert.ok(res.json.error.details);
});

test('create is blocked without authentication and without CSRF', async () => {
  ctx.client.clearCookies();
  const noAuth = await ctx.client.post('/api/v1/payment-methods', {
    name: 'NoAuth',
    type: 'crypto',
    used_for: 'both',
  });
  assert.equal(noAuth.status, 401);

  const relogin = await ctx.client.post('/api/v1/auth/login', { email: OWNER, password: PASSWORD });
  assert.equal(relogin.status, 200);

  const noCsrf = await ctx.client.post('/api/v1/payment-methods', {
    name: 'NoCsrf',
    type: 'crypto',
    used_for: 'both',
  });
  assert.equal(noCsrf.status, 403);
  assert.equal(noCsrf.json.error.code, 'CSRF_TOKEN_INVALID');

  // Nothing was written.
  const check = await ctx.client.get('/api/v1/payment-methods?search=NoCsrf');
  assert.equal(check.json.meta.pagination.total, 0);
});

test('update changes fields and records a diff in the audit trail', async () => {
  const created = await ctx.client.withCsrf('POST', '/api/v1/payment-methods', {
    name: 'Updatable',
    type: 'currency',
    used_for: 'deposit',
  });
  const id = created.json.data.id;

  const updated = await ctx.client.withCsrf('PATCH', `/api/v1/payment-methods/${id}`, {
    name: 'Updatable Method',
    type: 'crypto',
    used_for: 'withdraw',
    status: 'enabled',
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.json.data.name, 'Updatable Method');
  assert.equal(updated.json.data.type, 'crypto');
  assert.equal(updated.json.data.used_for, 'withdraw');
  assert.equal(updated.json.data.status, 'enabled');

  const log = await ctx.client.get('/api/v1/audit-log?action=payment_method.updated&per_page=5');
  const entry = log.json.data.find((e) => e.entity_id === id);
  assert.ok(entry, 'audit entry must exist');
  assert.equal(entry.actor.email, OWNER);
  assert.match(entry.summary, /Updated payment method/);
  assert.equal(entry.before.status, 'disabled');
  assert.equal(entry.after.status, 'enabled');
  assert.ok(!JSON.stringify(entry).includes('$2'), 'no hashes in the audit log');
});

test('update returns 404 for an unknown method', async () => {
  const res = await ctx.client.withCsrf('PATCH', '/api/v1/payment-methods/PAY-99999', {
    status: 'enabled',
  });
  assert.equal(res.status, 404);
});

test('update rejects an invalid patch without touching the row', async () => {
  const created = await ctx.client.withCsrf('POST', '/api/v1/payment-methods', {
    name: 'Stricter',
    type: 'crypto',
    used_for: 'both',
  });
  const id = created.json.data.id;

  const bad = await ctx.client.withCsrf('PATCH', `/api/v1/payment-methods/${id}`, {
    status: 'approved',
  });
  assert.equal(bad.status, 422);

  const again = await ctx.client.get(`/api/v1/payment-methods/${id}`);
  assert.equal(again.json.data.status, 'disabled');
});

test('enable and disable flip the status and are audited', async () => {
  const created = await ctx.client.withCsrf('POST', '/api/v1/payment-methods', {
    name: 'Toggle Me',
    type: 'crypto',
    used_for: 'both',
  });
  const id = created.json.data.id;
  assert.equal(created.json.data.status, 'disabled');

  const enabled = await ctx.client.withCsrf('POST', `/api/v1/payment-methods/${id}/enable`, {});
  assert.equal(enabled.status, 200);
  assert.equal(enabled.json.data.status, 'enabled');

  const disabled = await ctx.client.withCsrf('POST', `/api/v1/payment-methods/${id}/disable`, {});
  assert.equal(disabled.status, 200);
  assert.equal(disabled.json.data.status, 'disabled');

  const log = await ctx.client.get('/api/v1/audit-log?per_page=100');
  const entries = log.json.data.filter((e) => e.entity_id === id);
  assert.ok(entries.some((e) => e.action === 'payment_method.enabled'));
  assert.ok(entries.some((e) => e.action === 'payment_method.disabled'));
});

test('delete removes the row and is audited with the full before-state', async () => {
  const created = await ctx.client.withCsrf('POST', '/api/v1/payment-methods', {
    name: 'Delete Me',
    type: 'currency',
    used_for: 'deposit',
    status: 'enabled',
  });
  const id = created.json.data.id;

  const res = await ctx.client.withCsrf('DELETE', `/api/v1/payment-methods/${id}`, {});
  assert.equal(res.status, 204);

  const after = await ctx.client.get(`/api/v1/payment-methods/${id}`);
  assert.equal(after.status, 404);

  const log = await ctx.client.get('/api/v1/audit-log?action=payment_method.deleted&per_page=5');
  const entry = log.json.data.find((e) => e.entity_id === id);
  assert.ok(entry);
  assert.equal(entry.before.name, 'Delete Me');
  assert.equal(entry.before.used_for, 'deposit');
});

test('deleting an unknown method returns 404', async () => {
  const res = await ctx.client.withCsrf('DELETE', '/api/v1/payment-methods/PAY-99999', {});
  assert.equal(res.status, 404);
});

test('a support-role administrator can read but cannot write', async () => {
  await ctx.client.clearCookies();
  await ctx.client.post('/api/v1/auth/login', { email: SUPPORT, password: SUPPORT_PASSWORD });

  const read = await ctx.client.get('/api/v1/payment-methods?per_page=1');
  assert.equal(read.status, 200, 'support may read payment methods');

  const write = await ctx.client.withCsrf('POST', '/api/v1/payment-methods', {
    name: 'Support Attempt',
    type: 'crypto',
    used_for: 'both',
  });
  assert.equal(write.status, 403);
  assert.equal(write.json.error.code, 'FORBIDDEN');

  // Regression: the audit trail is documented as owner-only. It names
  // administrator emails and every administrative action, so a support account
  // must not be able to read it. Found by scripts/sweep.mjs.
  const audit = await ctx.client.get('/api/v1/audit-log?per_page=1');
  assert.equal(audit.status, 403, 'support must not read the audit log');
  assert.equal(audit.json.error.code, 'FORBIDDEN');
});

test('the audit log is paginated and never contains credentials', async () => {
  // Re-authenticate as the owner: the previous test left the support session in
  // the jar, and the audit trail is owner-only.
  await ctx.client.clearCookies();
  await ctx.client.post('/api/v1/auth/login', { email: OWNER, password: PASSWORD });

  const res = await ctx.client.get('/api/v1/audit-log?per_page=5');
  assert.equal(res.status, 200);
  assert.ok(res.json.meta.pagination.total >= 5);
  const auditText = JSON.stringify(res.json);

  // Asserts credential VALUES are absent. The WORDS "password"/"token"
  // legitimately appear in action names such as auth.password_changed, so a
  // naive substring check would false-positive on a correct log.
  assert.ok(!/\$2[aby]\$[0-9a-zA-Z./]{53}/.test(auditText), 'no bcrypt hash in the audit log');
  assert.ok(!auditText.includes(PASSWORD), 'owner password must not appear');
  assert.ok(!auditText.includes(SUPPORT_PASSWORD), 'support password must not appear');
  assert.ok(
    !auditText.includes(ctx.client.cookies.get('access_token')?.value ?? '<<none>>'),
    'access token value must not appear',
  );
  assert.ok(
    !auditText.includes(ctx.client.cookies.get('csrf_token')?.value ?? '<<none>>'),
    'csrf token value must not appear',
  );
});
