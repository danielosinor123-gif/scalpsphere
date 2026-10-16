/**
 * Payment methods module — the ONLY write surface in this API.
 *
 *   GET    /api/v1/payment-methods
 *   GET    /api/v1/payment-methods/:id
 *   POST   /api/v1/payment-methods                create
 *   PATCH  /api/v1/payment-methods/:id            update
 *   POST   /api/v1/payment-methods/:id/enable     set status = enabled
 *   POST   /api/v1/payment-methods/:id/disable    set status = disabled
 *   DELETE /api/v1/payment-methods/:id            hard delete
 *
 * This maps directly onto the "Payment Settings → Payment Methods" tab of the
 * supplied admin.html, whose `•••` button toggles Enabled/Disabled and whose
 * Delete button removes the row.
 *
 * IMPORTANT — the word "payment" here means *display configuration only*.
 * These rows are labels shown to an administrator. This API does not connect
 * to any payment provider, does not hold wallet addresses or card data, and
 * does not move money. `POST`/`DELETE` on real provider configuration must not
 * be enabled without a live integration, which is explicitly out of scope.
 */
import { asyncHandler, ok, created, paginated, noContent } from '../../lib/http.js';
import { parsePagination, buildPagination } from '../../lib/pagination.js';
import { validateOrThrow } from '../../lib/validation.js';
import { notFound, conflict, forbidden } from '../../lib/ApiError.js';
import { uuid } from '../../lib/ids.js';
import { serializePaymentMethod } from '../../lib/serialize.js';

const LIST_QUERY_SCHEMA = {
  // `page` / `per_page` are accepted here; parsePagination() is the
  // authoritative bounds check for both.
  page: { type: 'integer', min: 1, max: 1000000 },
  per_page: { type: 'integer', min: 1, max: 100 },
  search: { type: 'string', max: 120 },
  type: { type: 'enum', values: ['crypto', 'currency'] },
  used_for: { type: 'enum', values: ['deposit', 'withdraw', 'both'] },
  status: { type: 'enum', values: ['enabled', 'disabled'] },
  sort: { type: 'enum', values: ['created_at', 'name', 'status', 'type', 'id'], default: 'created_at' },
  direction: { type: 'enum', values: ['asc', 'desc'], default: 'desc' },
};

const ID_PARAM_SCHEMA = {
  id: { type: 'string', min: 1, max: 64, required: true },
};

const CREATE_BODY_SCHEMA = {
  name: { type: 'string', required: true, min: 2, max: 80, maxMessage: 'Method name must be at most 80 characters.' },
  type: { type: 'enum', required: true, values: ['crypto', 'currency'] },
  used_for: { type: 'enum', required: true, values: ['deposit', 'withdraw', 'both'] },
  status: { type: 'enum', values: ['enabled', 'disabled'], default: 'disabled' },
};

const UPDATE_BODY_SCHEMA = {
  name: { type: 'string', min: 2, max: 80 },
  type: { type: 'enum', values: ['crypto', 'currency'] },
  used_for: { type: 'enum', values: ['deposit', 'withdraw', 'both'] },
  status: { type: 'enum', values: ['enabled', 'disabled'] },
};

export function createPaymentMethodsModule({ repos, audit, requireAdminRole }) {
  async function load(id) {
    return repos.paymentMethodRepo.findById(id);
  }

  return function register(router) {
    // -------------------------------------------------------------------
    // GET /api/v1/payment-methods
    // -------------------------------------------------------------------
    router.get(
      '/payment-methods',
      asyncHandler(async (req, res) => {
        const pagination = parsePagination(req.query, { defaultPerPage: 20, maxPerPage: 100 });
        const query = validateOrThrow(LIST_QUERY_SCHEMA, req.query ?? {});

        const { rows, total, facets } = await repos.paymentMethodRepo.list({
          search: query.search ?? '',
          type: query.type,
          usedFor: query.used_for,
          status: query.status,
          sort: query.sort,
          direction: query.direction,
          limit: pagination.limit,
          offset: pagination.offset,
        });

        return paginated(
          res,
          rows.map(serializePaymentMethod),
          buildPagination(pagination.page, pagination.perPage, total),
          { facets },
        );
      }),
    );

    // -------------------------------------------------------------------
    // GET /api/v1/payment-methods/facets (declared before /:id)
    // -------------------------------------------------------------------
    router.get(
      '/payment-methods/facets',
      asyncHandler(async (_req, res) => {
        const { facets, total } = await repos.paymentMethodRepo.list({ limit: 1, offset: 0 });
        return ok(res, {
          total,
          status: [
            { key: 'enabled', label: 'Enabled', count: facets.enabled },
            { key: 'disabled', label: 'Disabled', count: facets.disabled },
          ],
          type: [
            { key: 'crypto', label: 'Crypto', count: facets.crypto },
            { key: 'currency', label: 'Currency', count: facets.currency },
          ],
          used_for: [
            { key: 'deposit', label: 'Deposit', count: null },
            { key: 'withdraw', label: 'Withdraw', count: null },
            { key: 'both', label: 'Both', count: null },
          ],
        });
      }),
    );

    // -------------------------------------------------------------------
    // GET /api/v1/payment-methods/:id
    // -------------------------------------------------------------------
    router.get(
      '/payment-methods/:id',
      asyncHandler(async (req, res) => {
        const { id } = validateOrThrow(ID_PARAM_SCHEMA, req.params);
        const row = await load(id);
        if (!row) throw notFound('No payment method exists with that id.');
        return ok(res, serializePaymentMethod(row));
      }),
    );

    // -------------------------------------------------------------------
    // POST /api/v1/payment-methods
    // -------------------------------------------------------------------
    router.post(
      '/payment-methods',
      requireAdminRole('owner', 'admin'),
      asyncHandler(async (req, res) => {
        const body = validateOrThrow(CREATE_BODY_SCHEMA, req.body ?? {});

        const existing = await repos.paymentMethodRepo.findByName(body.name);
        if (existing) {
          throw conflict('A payment method with this name already exists.', {
            field: 'name',
            existing_id: existing.public_ref,
          });
        }

        const id = uuid();
        const row = await repos.paymentMethodRepo.create({
          id,
          name: body.name,
          type: body.type,
          usedFor: body.used_for,
          status: body.status,
          isDemo: 0, // admin-created configuration, not a seeded demo row
        });

        await audit.record({
          req,
          adminId: req.auth.adminId,
          adminEmail: req.auth.email,
          action: 'payment_method.created',
          entityType: 'payment_method',
          entityId: row.public_ref,
          summary: `Created payment method ${row.name} (${row.type}, ${row.used_for}, ${row.status}).`,
          after: { name: row.name, type: row.type, used_for: row.used_for, status: row.status },
        });

        return created(res, serializePaymentMethod(row));
      }),
    );

    // -------------------------------------------------------------------
    // PATCH /api/v1/payment-methods/:id
    // -------------------------------------------------------------------
    router.patch(
      '/payment-methods/:id',
      requireAdminRole('owner', 'admin'),
      asyncHandler(async (req, res) => {
        const { id } = validateOrThrow(ID_PARAM_SCHEMA, req.params);
        const body = validateOrThrow(UPDATE_BODY_SCHEMA, req.body ?? {});

        const before = await load(id);
        if (!before) throw notFound('No payment method exists with that id.');

        if (body.name !== undefined && body.name.toLowerCase() !== before.name.toLowerCase()) {
          const clash = await repos.paymentMethodRepo.findByName(body.name);
          if (clash) throw conflict('A payment method with this name already exists.', { field: 'name' });
        }

        const after = await repos.paymentMethodRepo.update(id, {
          name: body.name,
          type: body.type,
          used_for: body.used_for,
          status: body.status,
        });
        if (!after) throw notFound('No payment method exists with that id.');

        await audit.record({
          req,
          adminId: req.auth.adminId,
          adminEmail: req.auth.email,
          action: 'payment_method.updated',
          entityType: 'payment_method',
          entityId: after.public_ref,
          summary: `Updated payment method ${after.name}.`,
          before: { name: before.name, type: before.type, used_for: before.used_for, status: before.status },
          after: { name: after.name, type: after.type, used_for: after.used_for, status: after.status },
        });

        return ok(res, serializePaymentMethod(after));
      }),
    );

    // -------------------------------------------------------------------
    // POST /api/v1/payment-methods/:id/enable | /disable
    // -------------------------------------------------------------------
    for (const action of ['enable', 'disable']) {
      router.post(
        `/payment-methods/:id/${action}`,
        requireAdminRole('owner', 'admin'),
        asyncHandler(async (req, res) => {
          const { id } = validateOrThrow(ID_PARAM_SCHEMA, req.params);
          const status = action === 'enable' ? 'enabled' : 'disabled';

          const before = await load(id);
          if (!before) throw notFound('No payment method exists with that id.');

          const after = await repos.paymentMethodRepo.update(id, { status });

          await audit.record({
            req,
            adminId: req.auth.adminId,
            adminEmail: req.auth.email,
            action: `payment_method.${action}d`,
            entityType: 'payment_method',
            entityId: after.public_ref,
            summary: `${after.name}: ${before.status} → ${status}.`,
            before: { status: before.status },
            after: { status },
          });

          return ok(res, serializePaymentMethod(after));
        }),
      );
    }

    // -------------------------------------------------------------------
    // DELETE /api/v1/payment-methods/:id
    // -------------------------------------------------------------------
    router.delete(
      '/payment-methods/:id',
      requireAdminRole('owner', 'admin'),
      asyncHandler(async (req, res) => {
        const { id } = validateOrThrow(ID_PARAM_SCHEMA, req.params);
        const before = await load(id);
        if (!before) throw notFound('No payment method exists with that id.');

        const removed = await repos.paymentMethodRepo.remove(id);
        if (!removed) throw notFound('No payment method exists with that id.');

        await audit.record({
          req,
          adminId: req.auth.adminId,
          adminEmail: req.auth.email,
          action: 'payment_method.deleted',
          entityType: 'payment_method',
          entityId: before.public_ref,
          summary: `Deleted payment method ${before.name}.`,
          before: {
            name: before.name,
            type: before.type,
            used_for: before.used_for,
            status: before.status,
          },
        });

        return noContent(res);
      }),
    );

    return router;
  };
}
