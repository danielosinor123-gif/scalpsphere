/**
 * Users: pagination, search, filtering, sorting, detail and validation.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestContext, createAdminAndLogin, seedUserAndWithdrawal } from './helpers/context.js';

let ctx;
const PASSWORD = 'Str0ng!Passw0rd#2026';

before(async () => {
  ctx = await createTestContext();
  await createAdminAndLogin(ctx, { email: 'owner@example.com', password: PASSWORD });
  // 12 demo users across known values so pagination/sorting is deterministic.
  for (let i = 0; i < 12; i += 1) {
    await seedUserAndWithdrawal(ctx, {
      user: {
        fullName: `Demo User ${String(i).padStart(2, '0')}`,
        email: `demo.user.${i}@example.com`,
        balanceMinor: (i + 1) * 1000,
        status: i % 3 === 0 ? 'inactive' : 'active',
        kycStatus: i % 2 === 0 ? 'verified' : 'pending',
      },
    });
  }
});

after(async () => {
  await ctx.close();
});

test('users list is paginated with documented metadata', async () => {
  const res = await ctx.client.get('/api/v1/users?page=1&per_page=5');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.json.data));
  assert.equal(res.json.data.length, 5);

  const { pagination } = res.json.meta;
  assert.equal(pagination.page, 1);
  assert.equal(pagination.per_page, 5);
  assert.equal(pagination.total, 12);
  assert.equal(pagination.total_pages, 3);
  assert.equal(pagination.has_next, true);
  assert.equal(pagination.has_prev, false);

  const page2 = await ctx.client.get('/api/v1/users?page=2&per_page=5');
  assert.equal(page2.json.meta.pagination.has_prev, true);
  assert.equal(page2.json.meta.pagination.has_next, true);

  const page3 = await ctx.client.get('/api/v1/users?page=3&per_page=5');
  assert.equal(page3.json.json ?? page3.json.meta.pagination.has_next, false);
});

test('user rows carry both minor units and the HTML display string', async () => {
  const res = await ctx.client.get('/api/v1/users?per_page=1&sort=name&direction=asc');
  const user = res.json.data[0];
  assert.equal(typeof user.balance_minor, 'number');
  assert.match(user.balance_display, /^\$/);
  const expected = `$${(user.balance_minor / 100).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
  assert.equal(user.balance_display, expected);
  for (const key of ['id', 'name', 'email', 'status', 'kyc_status', 'is_demo', 'created_at']) {
    assert.ok(key in user, `missing ${key}`);
  }
  assert.ok(!('ref' in user), 'the public reference is exposed once, as `id`');
  assert.equal(user.is_demo, true, 'seeded fixtures must be labelled as demo data');
});

test('seeded rows expose the short display reference, not a raw primary key', async () => {
  const res = await ctx.client.get('/api/v1/users?per_page=1');
  assert.match(res.json.data[0].id, /^USR-\d{5}$/);
});

test('search matches name, email and reference', async () => {
  const byName = await ctx.client.get('/api/v1/users?search=Demo%20User%2004');
  assert.equal(byName.status, 200);
  assert.ok(byName.json.data.length >= 1);
  assert.ok(byName.json.data.every((u) => u.name.includes('04') || u.email.includes('04')));

  const byEmail = await ctx.client.get('/api/v1/users?search=demo.user.7%40example.com');
  assert.equal(byEmail.json.data.length, 1);

  const none = await ctx.client.get('/api/v1/users?search=zzz-no-match-zzz');
  assert.equal(none.json.meta.pagination.total, 0);
  assert.deepEqual(none.json.data, []);
});

test('search is safe against SQL injection attempts (parameterised)', async () => {
  const payloads = [
    "' OR 1=1 --",
    '"; DROP TABLE users; --',
    "%' UNION SELECT password_hash FROM admins --",
    "\\' OR 'a'='a",
  ];
  for (const payload of payloads) {
    const res = await ctx.client.get(
      `/api/v1/users?search=${encodeURIComponent(payload)}`,
    );
    assert.equal(res.status, 200, `payload rejected: ${payload}`);
    assert.equal(res.json.meta.pagination.total, 0, `payload must match nothing: ${payload}`);
  }
  // The table must still be intact.
  const all = await ctx.client.get('/api/v1/users?per_page=100');
  assert.equal(all.json.meta.pagination.total, 12);
});

test('status and kyc filters work and are validated', async () => {
  const active = await ctx.client.get('/api/v1/users?status=active&per_page=100');
  assert.equal(active.status, 200);
  assert.ok(active.json.data.every((u) => u.status === 'active'));

  const verified = await ctx.client.get('/api/v1/users?kyc_status=verified&per_page=100');
  assert.ok(verified.json.data.every((u) => u.kyc_status === 'verified'));

  const bad = await ctx.client.get('/api/v1/users?status=deleted');
  assert.equal(bad.status, 422);
  assert.ok(bad.json.error.details.some((d) => d.field === 'status'));
});

test('sorting is restricted to the documented whitelist', async () => {
  const asc = await ctx.client.get('/api/v1/users?sort=balance&direction=asc&per_page=100');
  const values = asc.json.data.map((u) => u.balance_minor);
  assert.deepEqual(values, [...values].sort((a, b) => a - b));

  const bad = await ctx.client.get('/api/v1/users?sort=password_hash');
  assert.equal(bad.status, 422);
  assert.ok(bad.json.error.details.some((d) => d.field === 'sort'));
});

test('pagination parameters are bounds-checked', async () => {
  assert.equal((await ctx.client.get('/api/v1/users?page=0')).status, 422);
  assert.equal((await ctx.client.get('/api/v1/users?per_page=500')).status, 422);
  assert.equal((await ctx.client.get('/api/v1/users?page=abc')).status, 422);
});

test('facets report filter counts derived from the live table', async () => {
  const res = await ctx.client.get('/api/v1/users/facets');
  assert.equal(res.status, 200);
  assert.equal(res.json.data.total, 12);
  assert.equal(
    res.json.data.status.find((s) => s.key === 'active').count +
      res.json.data.status.find((s) => s.key === 'inactive').count,
    12,
  );
});

test('user detail returns 404 for an unknown reference', async () => {
  const res = await ctx.client.get('/api/v1/users/USR-99999');
  assert.equal(res.status, 404);
  assert.equal(res.json.error.code, 'NOT_FOUND');
});

test('user detail includes recent withdrawals', async () => {
  const seed = await seedUserAndWithdrawal(ctx);
  const res = await ctx.client.get(`/api/v1/users/${seed.user.public_ref}`);
  assert.equal(res.status, 200);
  assert.equal(res.json.data.email, seed.user.email);
  assert.ok(Array.isArray(res.json.data.recent_withdrawals));
  assert.equal(res.json.data.recent_withdrawals.length, 1);
});

test('users are read-only: no write endpoints exist', async () => {
  // The CSRF guard runs before route matching, so an unsafe method without a
  // token yields 403; with a valid token it must still be 404/405.
  const csrf = ctx.client.cookies.get('csrf_token')?.value ?? 'x'.repeat(32);
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const res = await ctx.client.request('/api/v1/users', {
      method,
      headers: { 'X-CSRF-Token': csrf },
      body: { full_name: 'x' },
    });
    assert.ok([404, 405].includes(res.status), `${method} /api/v1/users must not exist`);
  }
});
