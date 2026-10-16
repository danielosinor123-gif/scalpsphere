/**
 * Dashboard summary, activity series and recent users.
 *
 * Proves the four cards from the supplied admin.html are reproduced with
 * explicit live/demo provenance flags.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestContext, createAdminAndLogin, seedUserAndWithdrawal } from './helpers/context.js';

let ctx;
const PASSWORD = 'Str0ng!Passw0rd#2026';

before(async () => {
  ctx = await createTestContext();
  await createAdminAndLogin(ctx, { email: 'owner@example.com', password: PASSWORD });
});

after(async () => {
  await ctx.close();
});

test('summary exposes exactly the four admin.html cards in order', async () => {
  const res = await ctx.client.get('/api/v1/dashboard/summary');
  assert.equal(res.status, 200);

  const data = res.json.data;
  assert.deepEqual(data.card_order, [
    'total_users',
    'total_deposits',
    'pending_withdrawals',
    'active_investments',
  ]);

  assert.equal(data.cards.total_users.label, 'Total users');
  assert.equal(data.cards.total_deposits.label, 'Total deposits');
  assert.equal(data.cards.pending_withdrawals.label, 'Pending withdrawals');
  assert.equal(data.cards.active_investments.label, 'Active investments');

  for (const key of data.card_order) {
    assert.ok(data.cards[key].display_value, `${key} must expose display_value`);
    assert.equal(typeof data.cards[key].is_demo, 'boolean', `${key} must flag demo state`);
  }
});

test('total_users and pending_withdrawals are computed from the live tables', async () => {
  const before = await ctx.client.get('/api/v1/dashboard/summary');
  const usersBefore = before.json.data.cards.total_users.value;
  const pendingBefore = before.json.data.cards.pending_withdrawals.value;
  const pendingCountBefore = before.json.data.cards.pending_withdrawals.count;

  await seedUserAndWithdrawal(ctx);

  const after = await ctx.client.get('/api/v1/dashboard/summary');
  assert.equal(after.json.data.cards.total_users.value, usersBefore + 1);
  assert.equal(after.json.data.cards.total_users.is_demo, false);
  assert.equal(after.json.data.cards.total_users.source, 'users_table');

  assert.equal(
    after.json.data.cards.pending_withdrawals.count,
    pendingCountBefore + 1,
  );
  assert.ok(after.json.data.cards.pending_withdrawals.value > pendingBefore);
  assert.equal(after.json.data.cards.pending_withdrawals.is_demo, false);
  assert.equal(after.json.data.cards.pending_withdrawals.source, 'withdrawals_table');
});

test('deposit and investment cards are explicitly flagged as demo aggregates', async () => {
  const res = await ctx.client.get('/api/v1/dashboard/summary');
  const { cards } = res.json.data;
  assert.equal(cards.total_deposits.is_demo, true);
  assert.equal(cards.total_deposits.source, 'platform_metrics_daily');
  assert.equal(cards.active_investments.is_demo, true);
  assert.match(cards.total_deposits.trend.label, /[Dd]emo/);
  assert.match(cards.active_investments.trend.label, /[Dd]emo/);
});

test('summary includes the dashboard panels used by the HTML page', async () => {
  const res = await ctx.client.get('/api/v1/dashboard/summary');
  const { recent_users, recent_withdrawals, activity } = res.json.data;

  assert.ok(Array.isArray(recent_users));
  assert.ok(recent_users.length >= 1 && recent_users.length <= 4);
  for (const u of recent_users) {
    assert.ok(u.name);
    assert.ok(u.email);
    assert.equal(typeof u.balance_minor, 'number');
    assert.match(u.balance_display, /^\$/);
  }

  assert.ok(Array.isArray(recent_withdrawals));
  assert.ok(recent_withdrawals.length <= 3);

  assert.ok(activity.note.includes('synthetic demo fixtures'));
  assert.equal(activity.is_demo, true);
  assert.equal(activity.points.length, 7);
});

test('activity defaults to 7 points and fills gaps honestly', async () => {
  const res = await ctx.client.get('/api/v1/dashboard/activity');
  assert.equal(res.status, 200);
  const data = res.json.data;
  assert.equal(data.range, '7d');
  assert.equal(data.points.length, 7);
  for (const p of data.points) {
    assert.equal(p.is_demo, true);
    assert.equal(typeof p.deposits_minor, 'number');
    assert.equal(typeof p.withdrawals_minor, 'number');
    assert.match(p.date, /^\d{4}-\d{2}-\d{2}$/);
  }
});

test('activity accepts only the documented ranges', async () => {
  const ok30 = await ctx.client.get('/api/v1/dashboard/activity?range=30d');
  assert.equal(ok30.status, 200);
  assert.equal(ok30.json.data.points.length, 30);

  const bad = await ctx.client.get('/api/v1/dashboard/activity?range=forever');
  assert.equal(bad.status, 422);
});

test('recent users honours a bounded limit', async () => {
  const res = await ctx.client.get('/api/v1/dashboard/recent-users?limit=2');
  assert.equal(res.status, 200);
  assert.ok(res.json.data.length <= 2);

  const tooMany = await ctx.client.get('/api/v1/dashboard/recent-users?limit=99');
  assert.equal(tooMany.status, 422);
});
