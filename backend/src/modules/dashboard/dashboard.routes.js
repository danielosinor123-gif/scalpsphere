/**
 * Dashboard module.
 *
 * Reproduces the four stat cards that exist in the supplied admin.html, plus
 * the panel data on the same page.
 *
 * HONESTY RULE
 * ------------
 * The supplied HTML hardcodes all four numbers and labels them as demo
 * content. The brief forbids implementing real deposits, withdrawals,
 * investments, trading or staking. So:
 *
 *   - `total_users`           → computed live from the `users` table
 *   - `pending_withdrawals`   → computed live from the `withdrawals` table
 *   - `total_deposits`        → demo aggregate, flagged `is_demo: true`
 *   - `active_investments`    → demo aggregate, flagged `is_demo: true`
 *
 * Every card carries `source` and `is_demo` so a client cannot accidentally
 * present demo figures as live financial values.
 */
import { asyncHandler, ok } from '../../lib/http.js';
import { badRequest } from '../../lib/ApiError.js';
import { validateOrThrow } from '../../lib/validation.js';
import { formatMinor, formatCount } from '../../lib/money.js';

const ACTIVITY_QUERY_SCHEMA = {
  range: { type: 'enum', values: ['7d', '30d'], default: '7d' },
};

const DAYS = { '7d': 7, '30d': 30 };

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

export function createDashboardModule({ repos, settings }) {
  async function currentCurrency() {
    const row = await settings.get();
    return row?.default_currency ?? 'USD';
  }

  async function buildSummary() {
    const currency = await currentCurrency();
    const now = new Date();

    const [
      totalUsers,
      pendingWithdrawals,
      depositsAggregate,
      activeInvestments,
      usersThisMonth,
      usersPrevMonth,
    ] = await Promise.all([
      repos.userRepo.countAll(),
      repos.withdrawalRepo.pendingAggregate(now),
      repos.metricsRepo.sumByKey('deposits', { from: isoDate(new Date(now.getFullYear(), 0, 1)), to: isoDate(now) }),
      repos.metricsRepo.sumByKey('active_investments', { from: isoDate(now), to: isoDate(now) }),
      repos.userRepo.countCreatedBetween(
        new Date(now.getFullYear(), now.getMonth(), 1),
        new Date(now.getFullYear(), now.getMonth() + 1, 1),
      ),
      repos.userRepo.countCreatedBetween(
        new Date(now.getFullYear(), now.getMonth() - 1, 1),
        new Date(now.getFullYear(), now.getMonth(), 1),
      ),
    ]);

    const trendPercent =
      usersPrevMonth > 0 ? ((usersThisMonth - usersPrevMonth) / usersPrevMonth) * 100 : null;

    const cards = [
      {
        key: 'total_users',
        label: 'Total users',
        icon: 'users',
        value: totalUsers,
        display_value: formatCount(totalUsers),
        unit: 'users',
        source: 'users_table',
        is_demo: false,
        trend: {
          label: trendPercent === null
            ? `${usersThisMonth} new this month`
            : `${trendPercent >= 0 ? '+' : ''}${trendPercent.toFixed(1)}% this month`,
          direction: trendPercent === null ? 'flat' : trendPercent >= 0 ? 'up' : 'down',
          is_demo: false,
        },
      },
      {
        key: 'total_deposits',
        label: 'Total deposits',
        icon: 'deposits',
        value: depositsAggregate.amount_minor,
        display_value: formatMinor(depositsAggregate.amount_minor, currency),
        unit: currency,
        source: 'platform_metrics_daily',
        is_demo: true,
        trend: {
          label: 'Demo aggregate · deposits are out of scope',
          direction: 'flat',
          is_demo: true,
        },
      },
      {
        key: 'pending_withdrawals',
        label: 'Pending withdrawals',
        icon: 'withdrawals',
        value: pendingWithdrawals.amount_minor,
        display_value: formatMinor(pendingWithdrawals.amount_minor, currency),
        unit: currency,
        count: pendingWithdrawals.count,
        source: 'withdrawals_table',
        is_demo: false,
        trend: {
          label: `${pendingWithdrawals.count} request${pendingWithdrawals.count === 1 ? '' : 's'} awaiting`,
          direction: 'flat',
          is_demo: false,
        },
      },
      {
        key: 'active_investments',
        label: 'Active investments',
        icon: 'investments',
        value: activeInvestments.count_value,
        display_value: formatCount(activeInvestments.count_value),
        unit: 'investments',
        source: 'platform_metrics_daily',
        is_demo: true,
        trend: {
          label: 'Demo aggregate · investments are out of scope',
          direction: 'flat',
          is_demo: true,
        },
      },
    ];

    return { cards, currency };
  }

  return function register(router) {
    // -------------------------------------------------------------------
    // Dashboard summary
    // -------------------------------------------------------------------
    router.get(
      '/dashboard/summary',
      asyncHandler(async (req, res) => {
        const { cards, currency } = await buildSummary();

        const [recentWithdrawals, recentUsers, activity] = await Promise.all([
          repos.withdrawalRepo.list({ limit: 3, offset: 0 }),
          repos.userRepo.recent(4),
          buildActivity('7d'),
        ]);

        // Panels are stored in a stable key order that matches the HTML panels.
        const data = {
          generated_at: new Date().toISOString(),
          currency,
          cards: cards.reduce((acc, card) => {
            acc[card.key] = card;
            return acc;
          }, {}),
          card_order: ['total_users', 'total_deposits', 'pending_withdrawals', 'active_investments'],
          recent_withdrawals: recentWithdrawals.rows.map((r) => ({
            id: r.public_ref,
            client_name: r.client_name,
            amount_minor: Number(r.amount_minor),
            amount_display: formatMinor(Number(r.amount_minor), currency),
            payment_method: r.method,
            status: r.status,
            created_at: new Date(r.created_at).toISOString(),
          })),
          recent_users: recentUsers.map((r) => ({
            id: r.public_ref,
            name: r.full_name,
            email: r.email,
            balance_minor: Number(r.balance_minor),
            balance_display: formatMinor(Number(r.balance_minor), currency),
            status: r.status,
            kyc_status: r.kyc_status,
            created_at: new Date(r.created_at).toISOString(),
          })),
          activity,
        };

        return ok(res, data);
      }),
    );

    // -------------------------------------------------------------------
    // Platform activity series ("Deposits and withdrawals · last N days")
    // -------------------------------------------------------------------
    router.get(
      '/dashboard/activity',
      asyncHandler(async (req, res) => {
        const { range } = validateOrThrow(ACTIVITY_QUERY_SCHEMA, req.query ?? {});
        const data = await buildActivity(range);
        return ok(res, data);
      }),
    );

    async function buildActivity(range) {
      const days = DAYS[range] ?? 7;
      const to = new Date();
      const from = new Date(to.getTime() - (days - 1) * 24 * 60 * 60 * 1000);
      const points = await repos.metricsRepo.series({ from: isoDate(from), to: isoDate(to) });

      const missing = [];
      for (let i = 0; i < days; i += 1) {
        const d = new Date(from.getTime() + i * 24 * 60 * 60 * 1000);
        missing.push(isoDate(d));
      }
      const known = new Set(points.map((p) => p.date));
      const series = missing.map((date) => {
        const existing = points.find((p) => p.date === date);
        return existing ?? { date, deposits_minor: 0, withdrawals_minor: 0, is_demo: true };
      });

      return {
        range,
        days,
        is_demo: points.every((p) => p.is_demo),
        points: series,
        note:
          'Aggregate deposit/withdrawal rollups are synthetic demo fixtures. ' +
          'This API does not implement deposits or withdrawals.',
      };
    }

    // -------------------------------------------------------------------
    // Recent users (dashboard panel)
    // -------------------------------------------------------------------
    router.get(
      '/dashboard/recent-users',
      asyncHandler(async (req, res) => {
        const { limit } = validateOrThrow(
          { limit: { type: 'integer', min: 1, max: 10, default: 5 } },
          req.query ?? {},
        );
        const currency = await currentCurrency();
        const rows = await repos.userRepo.recent(limit);
        const data = rows.map((r) => ({
          id: r.public_ref,
          name: r.full_name,
          email: r.email,
          balance_minor: Number(r.balance_minor),
          balance_display: formatMinor(Number(r.balance_minor), currency),
          status: r.status,
          kyc_status: r.kyc_status,
          created_at: new Date(r.created_at).toISOString(),
        }));
        return ok(res, data);
      }),
    );

    return router;
  };
}
