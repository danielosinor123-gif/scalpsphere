/**
 * Users module — read-only.
 *
 *   GET /api/v1/users            searchable, filterable, paginated
 *   GET /api/v1/users/recent     most recently registered users (dashboard panel)
 *   GET /api/v1/users/facets     filter counts for the table UI
 *   GET /api/v1/users/:id        single user (the HTML "View" button)
 *
 * There is intentionally no create/update/delete here: the brief grants write
 * endpoints only for the non-live demo payment-method configuration.
 *
 * Search matches the display name, email address and public reference
 * (`USR-00001`) — the columns the HTML table actually shows.
 */
import { asyncHandler, ok, paginated } from '../../lib/http.js';
import { parsePagination, buildPagination } from '../../lib/pagination.js';
import { validateOrThrow } from '../../lib/validation.js';
import { notFound } from '../../lib/ApiError.js';
import { formatMinor } from '../../lib/money.js';
import { serializeUser, serializeWithdrawal } from '../../lib/serialize.js';

const LIST_QUERY_SCHEMA = {
  // `page` / `per_page` are accepted here; parsePagination() is the
  // authoritative bounds check for both.
  page: { type: 'integer', min: 1, max: 1000000 },
  per_page: { type: 'integer', min: 1, max: 100 },
  search: { type: 'string', max: 120 },
  status: { type: 'enum', values: ['active', 'inactive'] },
  kyc_status: { type: 'enum', values: ['pending', 'verified', 'rejected'] },
  sort: { type: 'enum', values: ['created_at', 'balance', 'name', 'id', 'status'], default: 'created_at' },
  direction: { type: 'enum', values: ['asc', 'desc'], default: 'desc' },
};

const ID_PARAM_SCHEMA = {
  id: { type: 'string', min: 1, max: 64, required: true },
};

export function createUsersModule({ repos, settings }) {
  async function currency() {
    const row = await settings.get();
    return row?.default_currency ?? 'USD';
  }

  return function register(router) {
    // -------------------------------------------------------------------
    // GET /api/v1/users
    // -------------------------------------------------------------------
    router.get(
      '/users',
      asyncHandler(async (req, res) => {
        const pagination = parsePagination(req.query, { defaultPerPage: 20 });
        const query = validateOrThrow(LIST_QUERY_SCHEMA, req.query ?? {});
        const currencyCode = await currency();

        const { rows, total, facets } = await repos.userRepo.list({
          search: query.search ?? '',
          status: query.status,
          kycStatus: query.kyc_status,
          sort: query.sort,
          direction: query.direction,
          limit: pagination.limit,
          offset: pagination.offset,
        });

        return paginated(
          res,
          rows.map((r) => serializeUser(r, currencyCode)),
          buildPagination(pagination.page, pagination.perPage, total),
          { facets },
        );
      }),
    );

    // -------------------------------------------------------------------
    // GET /api/v1/users/recent  (declared before /:id so it is not shadowed)
    // -------------------------------------------------------------------
    router.get(
      '/users/recent',
      asyncHandler(async (req, res) => {
        const { limit } = validateOrThrow(
          { limit: { type: 'integer', min: 1, max: 10, default: 5 } },
          req.query ?? {},
        );
        const currencyCode = await currency();
        const rows = await repos.userRepo.recent(limit);
        return ok(res, rows.map((r) => serializeUser(r, currencyCode)));
      }),
    );

    // -------------------------------------------------------------------
    // GET /api/v1/users/facets
    // -------------------------------------------------------------------
    router.get(
      '/users/facets',
      asyncHandler(async (_req, res) => {
        const { facets, total } = await repos.userRepo.list({ limit: 1, offset: 0 });
        const currencyCode = await currency();
        return ok(res, {
          currency: currencyCode,
          total,
          status: [
            { key: 'active', label: 'Active', count: facets.active },
            { key: 'inactive', label: 'Inactive', count: facets.inactive },
          ],
          kyc_status: [
            { key: 'pending', label: 'Pending', count: facets.kyc_pending },
            { key: 'verified', label: 'Verified', count: facets.kyc_verified },
          ],
        });
      }),
    );

    // -------------------------------------------------------------------
    // GET /api/v1/users/:id
    // -------------------------------------------------------------------
    router.get(
      '/users/:id',
      asyncHandler(async (req, res) => {
        const { id } = validateOrThrow(ID_PARAM_SCHEMA, req.params);
        const currencyCode = await currency();
        const row = await repos.userRepo.findById(id);
        if (!row) throw notFound('No user exists with that id or reference.');

        const withdrawals = await repos.withdrawalRepo.recentForUser(row.id, 5);
        return ok(res, {
          ...serializeUser(row, currencyCode),
          recent_withdrawals: withdrawals.map((w) => serializeWithdrawal(w, currencyCode)),
        });
      }),
    );

    return router;
  };
}
