/**
 * Withdrawals: pagination, search, status/method filters, detail, validation,
 * and confirmation that no money-movement endpoints exist.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestContext, createAdminAndLogin, seedUserAndWithdrawal } from './helpers/context.js';

let ctx;
const PASSWORD = 'Str0ng!Passw0rd#2026';

before(async () => {
  ctx = await createTestContext();
  await createAdminAndLogin(ctx, { email: 'owner@example.com', password: PASSWORD });
  for (let i = 0; i < 8; i += 1) {
    await seedUserAndWithdrawal(ctx, {
      user: { fullName: `Client ${String(i).padStart(2, '0')}`, email: `client${i}@example.com` },
      withdrawal: {
        amountMinor: (i + 1) * 1000,
        feeMinor: 100,
        method: i % 2 === 0 ? 'USDT' : 'Ethereum',
        status: i % 4 === 0 ? 'processed' : 'pending',
        receiverEmail: `receiver${i}@example.org`,
      },
    });
  }
});

after(async () => {
  await ctx.close();
});

test('withdrawals list is paginated with documented metadata', async () => {
  const res = await ctx.client.get('/api/v1/withdrawals?page=1&per_page=3');
  assert.equal(res.status, 200);
  assert.equal(res.json.data.length, 3);
  assert.equal(res.json.meta.pagination.total, 8);
  assert.equal(res.json.meta.pagination.total_pages, 3);
});

test('withdrawal rows carry the admin.html column names', async () => {
  const res = await ctx.client.get('/api/v1/withdrawals?per_page=1');
  const row = res.json.data[0];
  for (const key of [
    'id', 'user_ref', 'client_name',
    'amount_minor', 'amount_display', 'fee_minor', 'fee_display',
    'net_minor', 'net_display', 'payment_method', 'receiver_email',
    'status', 'is_demo', 'created_at',
  ]) {
    assert.ok(key in row, `missing ${key}`);
  }
  assert.equal(row.net_minor, row.amount_minor - row.fee_minor);
});

test('search matches client, method and receiver email', async () => {
  const name = await ctx.client.get('/api/v1/withdrawals?search=Client%2003');
  assert.ok(name.json.meta.pagination.total >= 1);
  assert.ok(name.json.data.every((r) => r.client_name.includes('03')));

  const method = await ctx.client.get('/api/v1/withdrawals?method=Ethereum&per_page=100');
  assert.ok(method.json.data.every((r) => r.payment_method === 'Ethereum'));
  assert.equal(method.json.meta.pagination.total, 4);

  const receiver = await ctx.client.get('/api/v1/withdrawals?search=receiver5%40example.org');
  assert.equal(receiver.json.meta.pagination.total, 1);
});

test('SQL injection payloads are treated as literal search text', async () => {
  for (const payload of ["' OR '1'='1", "'; DELETE FROM withdrawals; --", '%" OR ""="']) {
    const res = await ctx.client.get(`/api/v1/withdrawals?search=${encodeURIComponent(payload)}`);
    assert.equal(res.status, 200);
    assert.equal(res.json.meta.pagination.total, 0, payload);
  }
  const all = await ctx.client.get('/api/v1/withdrawals?per_page=100');
  assert.equal(all.json.meta.pagination.total, 8);
});

test('status filter accepts only the documented statuses', async () => {
  const pending = await ctx.client.get('/api/v1/withdrawals?status=pending&per_page=100');
  assert.ok(pending.json.data.every((r) => r.status === 'pending'));
  assert.equal(pending.json.meta.pagination.total, 6);

  const bad = await ctx.client.get('/api/v1/withdrawals?status=approved');
  assert.equal(bad.status, 422);
  assert.ok(bad.json.error.details.some((d) => d.field === 'status'));
});

test('facets report the pending queue used by the dashboard card', async () => {
  const res = await ctx.client.get('/api/v1/withdrawals/facets');
  assert.equal(res.status, 200);
  assert.equal(res.json.data.pending.count, 6);
  assert.equal(typeof res.json.data.pending.amount_minor, 'number');
  assert.equal(res.json.data.pending.amount_display.slice(0, 1), '$');
  assert.deepEqual(res.json.data.statuses, ['pending', 'processed', 'failed', 'cancelled']);
});

test('detail endpoint returns a single withdrawal and 404 for unknown ids', async () => {
  const list = await ctx.client.get('/api/v1/withdrawals?per_page=1');
  const ref = list.json.data[0].id;
  const res = await ctx.client.get(`/api/v1/withdrawals/${ref}`);
  assert.equal(res.status, 200);
  assert.equal(res.json.data.id, ref);

  const missing = await ctx.client.get('/api/v1/withdrawals/WDR-99999');
  assert.equal(missing.status, 404);
});

test('date filters are validated', async () => {
  assert.equal((await ctx.client.get('/api/v1/withdrawals?from=2026-10-01')).status, 200);
  assert.equal((await ctx.client.get('/api/v1/withdrawals?from=yesterday')).status, 422);
  assert.equal((await ctx.client.get('/api/v1/withdrawals?from=2026-12-01&to=2026-01-01')).status, 400);
});

test('no withdrawal mutation endpoints are exposed', async () => {
  const csrf = ctx.client.cookies.get('csrf_token')?.value ?? 'x'.repeat(32);
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const res = await ctx.client.request('/api/v1/withdrawals', {
      method,
      headers: { 'X-CSRF-Token': csrf },
      body: { status: 'processed' },
    });
    assert.ok([404, 405].includes(res.status), `${method} /api/v1/withdrawals must not exist`);
  }
  for (const path of ['/api/v1/withdrawals/WDR-00001/approve', '/api/v1/withdrawals/WDR-00001/process']) {
    const res = await ctx.client.request(path, {
      method: 'POST',
      headers: { 'X-CSRF-Token': csrf },
    });
    assert.equal(res.status, 404, `${path} must not exist`);
  }
});
