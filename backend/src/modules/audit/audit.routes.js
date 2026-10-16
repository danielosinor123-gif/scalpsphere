/**
 * Audit module.
 *
 *   GET /api/v1/audit-log   paginated administrative change trail
 *
 * Exposed so an operator can prove what changed, who changed it, and when.
 * Restricted to the `owner` role — entries name administrator emails and every
 * administrative action, which is not appropriate for a `support` account.
 * Entries never contain credentials: the audit service redacts a deny-list and
 * refuses to write anything else.
 */
import { asyncHandler, paginated } from '../../lib/http.js';
import { parsePagination, buildPagination } from '../../lib/pagination.js';
import { validateOrThrow } from '../../lib/validation.js';
import { serializeAuditEntry } from '../../lib/serialize.js';

const LIST_QUERY_SCHEMA = {
  // `page` / `per_page` are accepted here; parsePagination() is the
  // authoritative bounds check for both.
  page: { type: 'integer', min: 1, max: 1000000 },
  per_page: { type: 'integer', min: 1, max: 100 },
  action: { type: 'string', max: 80 },
  entity_type: { type: 'string', max: 60 },
  from: {
    type: 'string',
    max: 40,
    pattern: /^\d{4}-\d{2}-\d{2}([T ].*)?$/,
    patternMessage: 'Use an ISO-8601 date (YYYY-MM-DD).',
  },
  to: {
    type: 'string',
    max: 40,
    pattern: /^\d{4}-\d{2}-\d{2}([T ].*)?$/,
    patternMessage: 'Use an ISO-8601 date (YYYY-MM-DD).',
  },
};

export function createAuditModule({ repos, requireAdminRole }) {
  return function register(router) {
    router.get(
      '/audit-log',
      // Enforces what docs/API_CONTRACT.md §3.8 and openapi.yaml already
      // promised: the audit trail is owner-only.
      requireAdminRole('owner'),
      asyncHandler(async (req, res) => {
        const pagination = parsePagination(req.query, { defaultPerPage: 25, maxPerPage: 100 });
        const query = validateOrThrow(LIST_QUERY_SCHEMA, req.query ?? {});

        const { rows, total } = await repos.auditRepo.list({
          page: pagination.page,
          perPage: pagination.perPage,
          action: query.action,
          entityType: query.entity_type,
          from: query.from ? new Date(query.from) : undefined,
          to: query.to ? new Date(query.to) : undefined,
        });

        return paginated(
          res,
          rows.map(serializeAuditEntry),
          buildPagination(pagination.page, pagination.perPage, total),
        );
      }),
    );
  };
}
