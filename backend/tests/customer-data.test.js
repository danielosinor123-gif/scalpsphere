/**
 * CUSTOMER DATA + ISOLATION
 *
 * The three properties this file exists to prove:
 *
 *  1. OWNERSHIP ISOLATION — one customer can never read another customer's
 *     records, on either the list or the detail endpoint.
 *  2. READ-ONLY FINANCIALS — no customer endpoint mutates a balance or a
 *     withdrawal. Snapshot the row, hit every endpoint, compare.
 *  3. SHARED SOURCE OF TRUTH — the customer portal and the admin panel read the
 *     SAME `users` and `withdrawals` rows, and agree on every field.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  createTestContext, createAdminAndLogin, createCustomerAndLogin, CUSTOMER_PASSWORD,
} from './helpers/context.js';

let ctx;
let adminHeaders;

before(async () => {
  ctx = await createTestContext();
  const admin = await createAdminAndLogin(ctx, { email: 'cx-admin@example.com' });
  adminHeaders = { Authorization: `Bearer ${admin.accessToken}` };
});

after(async () => {
  await ctx.close();
});

// ---------------------------------------------------------------------------
// 1. Ownership isolation
// ---------------------------------------------------------------------------
test('a customer only ever sees their OWN withdrawals in the list', async () => {
  const alice = await createCustomerAndLogin(ctx, {
    user: { email: `alice-${Date.now()}@example.com`, balanceMinor: 10000 },
    withdrawal: { amountMinor: 1111, feeMinor: 11, method: 'USDT', status: 'pending', receiverEmail: 'a@example.com' },
  });
  const bob = await createCustomerAndLogin(ctx, {
    user: { email: `bob-${Date.now()}@example.com`, balanceMinor: 20000 },
    withdrawal: { amountMinor: 2222, feeMinor: 22, method: 'Ethereum', status: 'processed', receiverEmail: 'b@example.com' },
  });

  const aliceList = await ctx.client.get('/api/v1/customer/withdrawals', { headers: alice.authHeaders });
  const bobList = await ctx.client.get('/api/v1/customer/withdrawals', { headers: bob.authHeaders });

  assert.equal(aliceList.status, 200);
  assert.equal(bobList.status, 200);
  assert.equal(aliceList.json.data.length, 1);
  assert.equal(bobList.json.data.length, 1);
  assert.equal(aliceList.json.data[0].amount_minor, 1111);
  assert.equal(bobList.json.data[0].amount_minor, 2222);
  // Cross-contamination: neither list may contain the other's record.
  const aliceText = JSON.stringify(aliceList.json);
  const bobText = JSON.stringify(bobList.json);
  assert.ok(!aliceText.includes(String(bob.user.public_ref)));
  assert.ok(!bobText.includes(String(alice.user.public_ref)));
});

test('a customer CANNOT read another customer\'s withdrawal by its id', async () => {
  const alice = await createCustomerAndLogin(ctx, {
    user: { email: `iso-a-${Date.now()}@example.com` },
    withdrawal: { amountMinor: 3333, feeMinor: 33, method: 'USDT', status: 'pending', receiverEmail: 'a@example.com' },
  });
  const mallory = await createCustomerAndLogin(ctx, {
    user: { email: `iso-m-${Date.now()}@example.com` },
  });

  // Mallory learns Alice's withdrawal reference from somewhere.
  const aliceList = await ctx.client.get('/api/v1/customer/withdrawals', { headers: alice.authHeaders });
  const aliceRef = aliceList.json.data[0].id;
  assert.ok(aliceRef);

  const res = await ctx.client.get(`/api/v1/customer/withdrawals/${aliceRef}`, { headers: mallory.authHeaders });
  // 404, not 403: the record must not be confirmed to exist.
  assert.equal(res.status, 404);
  assert.equal(res.json.error.code, 'NOT_FOUND');

  // Sanity: Alice herself CAN read it.
  const own = await ctx.client.get(`/api/v1/customer/withdrawals/${aliceRef}`, { headers: alice.authHeaders });
  assert.equal(own.status, 200);
  assert.equal(own.json.data.id, aliceRef);
});

test('an unknown withdrawal id is 404 for the owner too', async () => {
  const c = await createCustomerAndLogin(ctx);
  const res = await ctx.client.get('/api/v1/customer/withdrawals/WDR-99999', { headers: c.authHeaders });
  assert.equal(res.status, 404);
});

test('customer identity is never taken from a request parameter', async () => {
  const alice = await createCustomerAndLogin(ctx, { user: { email: `param-a-${Date.now()}@example.com` } });
  const bob = await createCustomerAndLogin(ctx, { user: { email: `param-b-${Date.now()}@example.com` } });

  // Try to impersonate Bob by every plausible spelling of a user id.
  const attempts = [
    `/api/v1/customer/withdrawals?user_id=${bob.user.id}`,
    `/api/v1/customer/withdrawals?userId=${bob.user.id}`,
    `/api/v1/customer/withdrawals?user=${bob.user.public_ref}`,
    `/api/v1/customer/profile?user_id=${bob.user.id}`,
    `/api/v1/customer/dashboard/summary?user_id=${bob.user.id}`,
  ];
  for (const url of attempts) {
    const res = await ctx.client.get(url, { headers: alice.authHeaders });
    assert.equal(res.status, 422, `${url} must reject the unknown parameter`);
    assert.ok(res.json.error.details.some((d) => /user/i.test(d.field)), url);
  }

  // And confirm the profile Alice reads is her own, not Bob's.
  const profile = await ctx.client.get('/api/v1/customer/profile', { headers: alice.authHeaders });
  assert.equal(profile.json.data.email, alice.user.email);
});

// ---------------------------------------------------------------------------
// 2. Read-only financials
// ---------------------------------------------------------------------------
test('NO customer endpoint mutates the balance or the withdrawal records', async () => {
  const c = await createCustomerAndLogin(ctx, {
    user: { email: `ro-${Date.now()}@example.com`, balanceMinor: 65432 },
    withdrawal: { amountMinor: 4321, feeMinor: 55, method: 'USDT', status: 'pending', receiverEmail: 'ro@example.com' },
  });

  // Snapshot the exact rows first.
  const usersBefore = await ctx.client.get('/api/v1/users?per_page=100', { headers: adminHeaders });
  const before = usersBefore.json.data.find((u) => u.email === c.user.email);
  const wdsBefore = await ctx.client.get('/api/v1/customer/withdrawals', { headers: c.authHeaders });

  // Hit every read and the single permitted write.
  const endpoints = [
    '/api/v1/customer/auth/session',
    '/api/v1/customer/profile',
    '/api/v1/customer/dashboard/summary',
    '/api/v1/customer/withdrawals',
    '/api/v1/customer/withdrawals?status=pending',
    '/api/v1/customer/withdrawals?sort=amount&direction=asc',
    '/api/v1/customer/kyc',
    '/api/v1/customer/payment-methods?used_for=deposit',
  ];
  for (const path of endpoints) {
    const res = await ctx.client.get(path, { headers: c.authHeaders });
    assert.equal(res.status, 200, `${path} -> ${res.status}`);
  }
  // The one allowed write: a name change.
  const patch = await ctx.client.request('/api/v1/customer/profile', {
    method: 'PATCH',
    headers: c.authHeaders,
    body: { full_name: 'Renamed Customer' },
  });
  assert.equal(patch.status, 200);

  // Compare afterwards.
  const usersAfter = await ctx.client.get('/api/v1/users?per_page=100', { headers: adminHeaders });
  const after = usersAfter.json.data.find((u) => u.email === c.user.email);
  const wdsAfter = await ctx.client.get('/api/v1/customer/withdrawals', { headers: c.authHeaders });

  assert.equal(after.balance_minor, before.balance_minor, 'balance must be untouched');
  assert.equal(after.kyc_status, before.kyc_status, 'KYC status must be untouched');
  assert.equal(after.status, before.status, 'account status must be untouched');
  assert.equal(after.email, before.email, 'email must be untouched');
  // The admin API exposes the display name as `name` (its HTML column);
  // the customer API exposes `full_name`. Same underlying column.
  assert.equal(after.name, 'Renamed Customer', 'only the name may change');

  // The withdrawal's OWN columns must be byte-identical. `client_name` and
  // `user_ref` are deliberately excluded: they are a live JOIN to the users row
  // (see withUserJoin in the memory driver), so they correctly follow the
  // rename this test itself performed. Asserting that explicitly is also the
  // regression check that both drivers stay in agreement.
  const ownColumns = (w) => ({
    id: w.id,
    amount_minor: w.amount_minor,
    fee_minor: w.fee_minor,
    net_minor: w.net_minor,
    payment_method: w.payment_method,
    receiver_email: w.receiver_email,
    status: w.status,
    created_at: w.created_at,
    updated_at: w.updated_at,
    is_demo: w.is_demo,
  });
  assert.deepEqual(
    wdsAfter.json.data.map(ownColumns),
    wdsBefore.json.data.map(ownColumns),
    'withdrawal-owned fields must be untouched by any read',
  );
  assert.equal(
    wdsAfter.json.data[0].client_name,
    'Renamed Customer',
    'client_name is a live join and must follow the rename',
  );
});

test('profile PATCH rejects every financial / admin-owned field', async () => {
  const c = await createCustomerAndLogin(ctx, { user: { email: `patch-${Date.now()}@example.com`, balanceMinor: 999 } });
  const forbidden = [
    { balance_minor: 999999 },
    { balance: 999999 },
    { currency: 'EUR' },
    { status: 'inactive' },
    { kyc_status: 'verified' },
    { email: 'new-email@example.com' },
    { is_demo: 0 },
  ];
  for (const body of forbidden) {
    const res = await ctx.client.request('/api/v1/customer/profile', {
      method: 'PATCH', headers: c.authHeaders, body,
    });
    assert.equal(res.status, 422, `PATCH ${JSON.stringify(body)} must be rejected`);
  }
  // And the row is unchanged.
  const users = await ctx.client.get('/api/v1/users?per_page=100', { headers: adminHeaders });
  const row = users.json.data.find((u) => u.email === c.user.email);
  assert.equal(row.balance_minor, 999);
  assert.equal(row.email, c.user.email);
});

test('profile PATCH validates the name', async () => {
  const c = await createCustomerAndLogin(ctx);
  for (const full_name of ['', 'x', 'a'.repeat(200)]) {
    const res = await ctx.client.request('/api/v1/customer/profile', {
      method: 'PATCH', headers: c.authHeaders, body: { full_name },
    });
    assert.equal(res.status, 422, `name "${full_name}" must be rejected`);
  }
});

// ---------------------------------------------------------------------------
// 3. Customer and admin read the SAME records
// ---------------------------------------------------------------------------
test('customer profile and admin user view agree on the same row', async () => {
  const c = await createCustomerAndLogin(ctx, {
    user: {
      email: `agree-${Date.now()}@example.com`,
      fullName: 'Consistency Check',
      balanceMinor: 77700,
      kycStatus: 'verified',
    },
  });

  const mine = await ctx.client.get('/api/v1/customer/profile', { headers: c.authHeaders });
  const adminView = await ctx.client.get(`/api/v1/users/${c.user.public_ref}`, { headers: adminHeaders });

  assert.equal(mine.status, 200);
  assert.equal(adminView.status, 200);
  // Same row, same values, through two different auth domains. Note the one
  // deliberate naming difference: the admin API calls the column `name`
  // (the admin table's column header) and the customer API calls it
  // `full_name` — both map to users.full_name.
  assert.equal(mine.json.data.id, adminView.json.data.id);
  assert.equal(mine.json.data.email, adminView.json.data.email);
  assert.equal(mine.json.data.full_name, adminView.json.data.name);
  assert.equal(mine.json.data.kyc_status, adminView.json.data.kyc_status);
  assert.equal(mine.json.data.member_since, adminView.json.data.created_at);
});

test('customer dashboard balance equals the admin panel balance for the same user', async () => {
  const c = await createCustomerAndLogin(ctx, {
    user: { email: `bal-${Date.now()}@example.com`, balanceMinor: 123456 },
  });

  const summary = await ctx.client.get('/api/v1/customer/dashboard/summary', { headers: c.authHeaders });
  const adminUsers = await ctx.client.get(`/api/v1/users/${c.user.public_ref}`, { headers: adminHeaders });

  assert.equal(summary.json.data.balance.minor, 123456);
  assert.equal(summary.json.data.balance.minor, adminUsers.json.data.balance_minor);
  assert.equal(summary.json.data.account.email, adminUsers.json.data.email);
});

test('customer withdrawal history is a strict subset of the admin view for that user', async () => {
  const c = await createCustomerAndLogin(ctx, {
    user: { email: `subset-${Date.now()}@example.com` },
    withdrawal: { amountMinor: 8642, feeMinor: 142, method: 'Solana', status: 'pending', receiverEmail: 'sub@example.com' },
  });

  const mine = await ctx.client.get('/api/v1/customer/withdrawals', { headers: c.authHeaders });
  const adminAll = await ctx.client.get('/api/v1/withdrawals?per_page=100', { headers: adminHeaders });
  const adminMine = adminAll.json.data.filter((w) => w.user_ref === c.user.public_ref);

  assert.equal(mine.json.meta.pagination.total, 1);
  assert.equal(adminMine.length, 1);
  assert.equal(mine.json.data[0].id, adminMine[0].id);
  assert.equal(mine.json.data[0].amount_minor, adminMine[0].amount_minor);
  assert.equal(mine.json.data[0].status, adminMine[0].status);
});

// ---------------------------------------------------------------------------
// 4. Response shapes and honest "unavailable" states
// ---------------------------------------------------------------------------
test('dashboard summary exposes real fields and explicit unavailable blocks', async () => {
  const c = await createCustomerAndLogin(ctx, {
    user: { email: `dash-${Date.now()}@example.com`, balanceMinor: 1000 },
    withdrawal: { amountMinor: 500, feeMinor: 10, method: 'USDT', status: 'pending', receiverEmail: 'd@example.com' },
  });

  const res = await ctx.client.get('/api/v1/customer/dashboard/summary', { headers: c.authHeaders });
  assert.equal(res.status, 200);
  const d = res.json.data;

  assert.ok(d.generated_at);
  assert.ok(d.account.member_since);
  assert.equal(d.balance.minor, 1000);
  assert.match(d.balance.display, /^\$/);
  assert.equal(d.balance.read_only, true);
  assert.equal(d.balance.source, 'users.balance_minor');
  assert.equal(d.withdrawals.pending_count, 1);
  assert.equal(d.withdrawals.pending_minor, 500);

  // The capabilities with no backing model are named, with reasons — never
  // invented as numbers.
  assert.ok(Array.isArray(d.unavailable) && d.unavailable.length > 0);
  const features = d.unavailable.map((u) => u.feature);
  for (const expected of ['performance_time_series', 'investments', 'staking', 'trading', 'mirror_trading', 'deposit_history']) {
    assert.ok(features.includes(expected), `missing unavailable block: ${expected}`);
  }
  for (const u of d.unavailable) assert.ok(u.reason, 'each unavailable block needs a reason');
  // No fabricated financial figures anywhere.
  assert.ok(!('total_invested' in d));
  assert.ok(!('roi_percent' in d));
});

test('withdrawals list is paginated and validates its filters', async () => {
  const c = await createCustomerAndLogin(ctx);
  assert.equal((await ctx.client.get('/api/v1/customer/withdrawals?page=0', { headers: c.authHeaders })).status, 422);
  assert.equal((await ctx.client.get('/api/v1/customer/withdrawals?per_page=500', { headers: c.authHeaders })).status, 422);
  assert.equal((await ctx.client.get('/api/v1/customer/withdrawals?status=approved', { headers: c.authHeaders })).status, 422);
  assert.equal((await ctx.client.get('/api/v1/customer/withdrawals?sort=password_hash', { headers: c.authHeaders })).status, 422);
  assert.equal((await ctx.client.get('/api/v1/customer/withdrawals?from=2026-12-01&to=2026-01-01', { headers: c.authHeaders })).status, 400);
  assert.equal((await ctx.client.get('/api/v1/customer/withdrawals?user_id=1', { headers: c.authHeaders })).status, 422);

  const ok = await ctx.client.get('/api/v1/customer/withdrawals?page=1&per_page=5', { headers: c.authHeaders });
  assert.equal(ok.status, 200);
  assert.ok(ok.json.meta.pagination);
});

test('customer payment-methods returns only ENABLED methods for the requested direction', async () => {
  const c = await createCustomerAndLogin(ctx);

  const deposits = await ctx.client.get('/api/v1/customer/payment-methods?used_for=deposit', { headers: c.authHeaders });
  assert.equal(deposits.status, 200);
  assert.ok(Array.isArray(deposits.json.data));
  for (const m of deposits.json.data) {
    assert.equal(m.status, 'enabled');
    assert.ok(['deposit', 'both'].includes(m.used_for));
  }

  const withdraw = await ctx.client.get('/api/v1/customer/payment-methods?used_for=withdraw', { headers: c.authHeaders });
  for (const m of withdraw.json.data) assert.ok(['withdraw', 'both'].includes(m.used_for));

  assert.equal(
    (await ctx.client.get('/api/v1/customer/payment-methods?used_for=both', { headers: c.authHeaders })).status,
    422,
  );

  // And the projection contains no admin-only fields.
  const text = JSON.stringify(deposits.json);
  assert.ok(!text.includes('"is_demo"'), 'customer projection must not leak demo flags');
});

test('KYC endpoint returns status metadata only, never documents', async () => {
  const c = await createCustomerAndLogin(ctx, { user: { kycStatus: 'pending' } });
  const res = await ctx.client.get('/api/v1/customer/kyc', { headers: c.authHeaders });
  assert.equal(res.status, 200);
  assert.equal(res.json.data.status, 'pending');
  assert.equal(res.json.data.documents_on_file, false);
  assert.ok(res.json.data.note.includes('identity documents'));
  assert.ok(!JSON.stringify(res.json).includes('document_url'));
});

test('customer payment-methods is the same data the admin panel configures', async () => {
  const c = await createCustomerAndLogin(ctx);
  const mine = await ctx.client.get('/api/v1/customer/payment-methods?used_for=deposit', { headers: c.authHeaders });

  // Admin enables a method; the customer projection must immediately show it.
  const adminCsrf = ctx.client.cookies.get('csrf_token')?.value ?? 'x'.repeat(32);
  const created = await ctx.client.request('/api/v1/payment-methods', {
    method: 'POST',
    headers: { Authorization: adminHeaders.Authorization, 'X-CSRF-Token': adminCsrf },
    body: { name: `Customer Visible ${Date.now()}`, type: 'crypto', used_for: 'deposit', status: 'enabled' },
  });
  assert.equal(created.status, 201);

  const after = await ctx.client.get('/api/v1/customer/payment-methods?used_for=deposit', { headers: c.authHeaders });
  assert.ok(after.json.data.some((m) => m.name === created.json.data.name));
  assert.equal(after.json.data.length, mine.json.data.length + 1);
});
