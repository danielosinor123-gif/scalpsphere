/**
 * Payment preferences / settings module.
 *
 * Backs the "Payment Preference" form in the supplied admin.html:
 *
 *   Default currency         USD — US Dollar | NGN — Nigerian Naira | EUR — Euro
 *   Payment processing mode  Automatic | Manual review
 *   Payment instructions     free text
 *   Minimum deposit          decimal amount (stored in minor units)
 *   Minimum withdrawal       decimal amount (stored in minor units)
 *
 *   GET  /api/v1/payment-settings
 *   PUT  /api/v1/payment-settings     full update
 *   PATCH /api/v1/payment-settings    partial update
 *   GET  /api/v1/payment-settings/currencies  (static option list)
 *
 * The remaining tabs of that page — "Coinpayment", "Gateways", "Transfer" —
 * render the same form in the current HTML and have no distinct data model, so
 * they are intentionally not modelled here (see docs/API_CONTRACT.md).
 */
import { asyncHandler, ok } from '../../lib/http.js';
import { validateOrThrow } from '../../lib/validation.js';
import { badRequest } from '../../lib/ApiError.js';
import { parseAmountToMinor, SUPPORTED_CURRENCIES, DEFAULT_CURRENCY } from '../../lib/money.js';
import { serializePaymentSettings } from '../../lib/serialize.js';

const PUT_BODY_SCHEMA = {
  default_currency: { type: 'enum', required: true, values: ['USD', 'EUR', 'NGN'] },
  processing_mode: { type: 'enum', required: true, values: ['automatic', 'manual_review'] },
  payment_instructions: { type: 'string', min: 0, max: 2000 },
  minimum_deposit: {
    type: 'money',
    required: true,
    min: 0,
    requiredMessage: 'Minimum deposit is required.',
  },
  minimum_withdrawal: {
    type: 'money',
    required: true,
    min: 0,
    requiredMessage: 'Minimum withdrawal is required.',
  },
};

const PATCH_BODY_SCHEMA = {
  default_currency: { type: 'enum', values: ['USD', 'EUR', 'NGN'] },
  processing_mode: { type: 'enum', values: ['automatic', 'manual_review'] },
  payment_instructions: { type: 'string', min: 0, max: 2000 },
  minimum_deposit: { type: 'money', min: 0 },
  minimum_withdrawal: { type: 'money', min: 0 },
};

/** 1,000,000.00 in minor units — a deliberately generous but finite ceiling. */
const MINOR_UNIT_LIMIT = 1_000_000 * 100;

export function createSettingsModule({ repos, audit, requireAdminRole }) {
  async function current() {
    const row = await repos.settingsRepo.get();
    return row ?? repos.settingsRepo.ensure();
  }

  async function toDto() {
    const row = await current();
    const updatedBy = row.updated_by ? await repos.adminRepo.findById(row.updated_by) : null;
    return serializePaymentSettings(row, { updated_by_email: updatedBy?.email ?? null });
  }

  return function register(router) {
    // -------------------------------------------------------------------
    // GET /api/v1/payment-settings
    // -------------------------------------------------------------------
    router.get(
      '/payment-settings',
      asyncHandler(async (_req, res) => {
        return ok(res, await toDto());
      }),
    );

    // -------------------------------------------------------------------
    // Static option list (keeps the client honest about allowed values)
    // -------------------------------------------------------------------
    router.get('/payment-settings/currencies', (_req, res) => {
      return ok(res, {
        default_currency: DEFAULT_CURRENCY,
        currencies: SUPPORTED_CURRENCIES,
        processing_modes: [
          { key: 'automatic', label: 'Automatic' },
          { key: 'manual_review', label: 'Manual review' },
        ],
      });
    });

    // -------------------------------------------------------------------
    // PUT /api/v1/payment-settings
    // -------------------------------------------------------------------
    const write = (partial) =>
      asyncHandler(async (req, res) => {
        const schema = partial ? PATCH_BODY_SCHEMA : PUT_BODY_SCHEMA;
        const body = validateOrThrow(schema, req.body ?? {}, { partial });

        const before = await toDto();

        const patch = {};
        if (body.default_currency !== undefined) patch.default_currency = body.default_currency;
        if (body.processing_mode !== undefined) patch.processing_mode = body.processing_mode;
        if (body.payment_instructions !== undefined) {
          patch.payment_instructions = body.payment_instructions || null;
        }

        const currency = body.default_currency ?? before.default_currency;
        if (body.minimum_deposit !== undefined) {
          patch.minimum_deposit_minor = bound(parseAmountToMinor(body.minimum_deposit, currency), 'minimum_deposit');
        }
        if (body.minimum_withdrawal !== undefined) {
          patch.minimum_withdrawal_minor = bound(parseAmountToMinor(body.minimum_withdrawal, currency), 'minimum_withdrawal');
        }

        await repos.settingsRepo.upsert(patch, req.auth.adminId);
        const after = await toDto();

        await audit.record({
          req,
          adminId: req.auth.adminId,
          adminEmail: req.auth.email,
          action: 'payment_settings.updated',
          entityType: 'payment_settings',
          entityId: '1',
          summary: 'Payment preferences updated.',
          before: {
            default_currency: before.default_currency,
            processing_mode: before.processing_mode,
            minimum_deposit_minor: before.minimum_deposit_minor,
            minimum_withdrawal_minor: before.minimum_withdrawal_minor,
          },
          after: {
            default_currency: after.default_currency,
            processing_mode: after.processing_mode,
            minimum_deposit_minor: after.minimum_deposit_minor,
            minimum_withdrawal_minor: after.minimum_withdrawal_minor,
          },
        });

        return ok(res, after);
      });

    router.put('/payment-settings', requireAdminRole('owner', 'admin'), write(false));
    router.patch('/payment-settings', requireAdminRole('owner', 'admin'), write(true));

    return router;
  };
}

function bound(minor, field) {
  if (minor > MINOR_UNIT_LIMIT) {
    throw badRequest(`${field} is unreasonably large.`, [{ field, message: 'Maximum 1,000,000.00.' }]);
  }
  return minor;
}
