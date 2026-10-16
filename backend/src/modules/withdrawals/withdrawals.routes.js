/**
 * Withdrawals module — read-only.
 *
 *   GET /api/v1/withdrawals        searchable, filterable, paginated
 *   GET /api/v1/withdrawals/:id    single request (the HTML "View" button)
 *   GET /api/v1/withdrawals/facets filter counts + pending totals for the header
 *
 * OUT OF SCOPE (by instruction): approving, rejecting, paying or cancelling a
 * withdrawal, contacting the receiver, and any payment-provider call. This
 * endpoint models the review queue only — it reads the table that the demo
 * "Manage clients withdrawals" page displays.
 */
import { asyncHandler, ok, paginated } from '../../lib/http.js';
import { parsePagination, buildPagination } from '../../lib/pagination.js';
import { validateOrThrow } from '../../lib/validation.js';
import { notFound, badRequest } from '../../lib/ApiError.js';
import { formatMinor } from '../../lib/money.js';
import { serializeWithdrawal } from '../../lib/serialize.js';

const LIST_QUERY_SCHEMA = {
  // `page` / `per_page` are accepted here; parsePagination() is the
  // authoritative bounds check for both.
  page: { type: 'integer', min: 1, max: 1000000 },
  per_page: { type: 'integer', min: 1, max: 100 },
  search: { type: 'string', max: 120 },
  status: { type: 'enum', values: ['pending', 'processed', 'failed', 'cancelled'] },
  method: { type: 'string', max: 80 },
  from: { type: 'string', max: 40, pattern: /^\d{4}-\d{2}-\d{2}([T ].*)?$/, patternMessage: 'Use an ISO-8601 date (YYYY-MM-DD).' },
  to: { type: 'string', max: 40, pattern: /^\d{4}-\d{2}-\d{2}([T ].*)?$/, patternMessage: 'Use an ISO-8601 date (YYYY-MM-DD).' },
  sort: { type: 'enum', values: ['created_at', 'amount', 'fee', 'status', 'id'], default: 'created_at' },
  direction: { type: 'enum', values: ['asc', 'desc'], default: 'desc' },
};

const ID_PARAM_SCHEMA = {
  id: { type: 'string', min: 1, max: 64, required: true },
};

export function createWithdrawalsModule({ repos, settings }) {
  async function currency() {
    const row = await settings.get();
    return row?.default_currency ?? 'USD';
  }

  function parseDateOrThrow(value, field) {
    if (value === undefined) return undefined;
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) {
      throw badRequest(`Invalid ${field}. Use an ISO-8601 date such as 2026-10-01.`);
    }
    return d;
  }

  return function register(router) {
    // -------------------------------------------------------------------
    // GET /api/v1/withdrawals
    // -------------------------------------------------------------------
    router.get(
      '/withdrawals',
      asyncHandler(async (req, res) => {
        const pagination = parsePagination(req.query, { defaultPerPage: 20 });
        const query = validateOrThrow(LIST_QUERY_SCHEMA, req.query ?? {});
        const currencyCode = await currency();

        const from = parseDateOrThrow(query.from, 'from');
        const to = parseDateOrThrow(query.to, 'to');
        if (from && to && from > to) {
          throw badRequest('"from" must be earlier than or equal to "to".');
        }

        const { rows, total } = await repos.withdrawalRepo.list({
          search: query.search ?? '',
          status: query.status,
          method: query.method,
          from,
          to,
          sort: query.sort,
          direction: query.direction,
          limit: pagination.limit,
          offset: pagination.offset,
        });

        return paginated(
          res,
          rows.map((r) => serializeWithdrawal(r, currencyCode)),
          buildPagination(pagination.page, pagination.perPage, total),
        );
      }),
    );

    // -------------------------------------------------------------------
    // GET /api/v1/withdrawals/facets (declared before /:id)
    // -------------------------------------------------------------------
    router.get(
      '/withdrawals/facets',
      asyncHandler(async (req, res) => {
        const currencyCode = await currency();
        const now = new Date();
        const [pending, { rows }] = await Promise.all([
          repos.withdrawalRepo.pendingAggregate(now),
          repos.withdrawalRepo.list({ limit: 1, offset: 0 }),
        ]);
        void rows;
        const methods = await repos.withdrawalRepo.distinctMethods();
        return ok(res, {
          currency: currencyCode,
          pending: {
            count: pending.count,
            amount_minor: pending.amount_minor,
            amount_display: formatMinor(pending.amount_minor, currencyCode),
          },
          statuses: ['pending', 'processed', 'failed', 'cancelled'],
          methods,
        });
      }),
    );

    // -------------------------------------------------------------------
    // GET /api/v1/withdrawals/:id
    // -------------------------------------------------------------------
    router.get(
      '/withdrawals/:id',
      asyncHandler(async (req, res) => {
        const { id } = validateOrThrow(ID_PARAM_SCHEMA, req.params);
        const currencyCode = await currency();
        const row = await repos.withdrawalRepo.findById(id);
        if (!row) throw notFound('No withdrawal request exists with that id or reference.');
        return ok(res, serializeWithdrawal(row, currencyCode));
      }),
    );

    return router;
  };
}
