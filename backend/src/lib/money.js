/**
 * Money handling.
 *
 * All monetary values are stored and transported as **integer minor units**
 * (e.g. cents) in `*_minor` fields. Fiat currency minor-unit exponents follow
 * ISO 4217. Crypto "currencies" in the demo method list are treated with 2
 * decimals for display parity with the HTML, but they are NOT priced or
 * converted anywhere — see the "no market data" note in the docs.
 */
import { validationError } from './ApiError.js';

const MINOR_UNIT_EXPONENTS = {
  USD: 2, EUR: 2, NGN: 2, GBP: 2, JPY: 0, KRW: 0, ZAR: 2, CAD: 2, AUD: 2,
};

export const SUPPORTED_CURRENCIES = [
  { code: 'USD', label: 'USD — US Dollar' },
  { code: 'NGN', label: 'NGN — Nigerian Naira' },
  { code: 'EUR', label: 'EUR — Euro' },
];

export const DEFAULT_CURRENCY = 'USD';

export function minorUnitExponent(currency) {
  return MINOR_UNIT_EXPONENTS[currency] ?? 2;
}

/**
 * Parse a client-supplied amount (number or decimal string) into minor units.
 * Rejects anything that is not a plain non-negative decimal with at most the
 * currency's number of decimal places. Never uses floating point for money.
 */
export function parseAmountToMinor(value, currency = DEFAULT_CURRENCY) {
  if (value === undefined || value === null || value === '') {
    throw validationError([{ field: 'amount', message: 'Amount is required.' }]);
  }
  let str;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw validationError([{ field: 'amount', message: 'Amount must be a finite number.' }]);
    if (!Number.isInteger(value * 10 ** minorUnitExponent(currency))) {
      throw validationError([
        {
          field: 'amount',
          message: `Amount has more than ${minorUnitExponent(currency)} decimal places for ${currency}.`,
        },
      ]);
    }
    str = value.toFixed(minorUnitExponent(currency));
  } else if (typeof value === 'string') {
    str = value.trim().replace(/,/g, '');
  } else {
    throw validationError([{ field: 'amount', message: 'Amount must be a number or decimal string.' }]);
  }

  if (!/^\d+(\.\d+)?$/.test(str)) {
    throw validationError([
      { field: 'amount', message: 'Amount must be a non-negative decimal number (e.g. 10.00).' },
    ]);
  }

  const [whole, frac = ''] = str.split('.');
  const exp = minorUnitExponent(currency);
  const padded = (frac + '0'.repeat(exp)).slice(0, exp);
  if (frac.length > exp) {
    throw validationError([
      { field: 'amount', message: `Amount has more than ${exp} decimal places for ${currency}.` },
    ]);
  }
  const minor = Number.parseInt(whole, 10) * 10 ** exp + Number.parseInt(padded || '0', 10);
  if (!Number.isSafeInteger(minor)) throw validationError([{ field: 'amount', message: 'Amount is too large.' }]);
  return minor;
}

const SYMBOLS = { USD: '$', EUR: '€', NGN: '₦', GBP: '£', JPY: '¥' };

/**
 * Render minor units the way the supplied admin.html renders them:
 *   "$450.00", "$1,250.00", "$84,290".
 */
export function formatMinor(minor, currency = DEFAULT_CURRENCY) {
  if (minor === null || minor === undefined) return null;
  const symbol = SYMBOLS[currency] ?? '';
  const exp = minorUnitExponent(currency);
  const negative = minor < 0;
  const abs = Math.abs(minor);
  const whole = Math.floor(abs / 10 ** exp);
  const frac = String(abs % 10 ** exp).padStart(exp, '0');
  const grouped = whole.toLocaleString('en-US');
  return `${negative ? '-' : ''}${symbol}${grouped}${exp > 0 ? `.${frac}` : ''}`;
}

/** Compact form used by the dashboard cards ("$84,290"). */
export function formatCompactCount(minor, currency = DEFAULT_CURRENCY) {
  const exp = minorUnitExponent(currency);
  const whole = Math.floor(Math.abs(minor) / 10 ** exp);
  const symbol = SYMBOLS[currency] ?? '';
  const sign = minor < 0 ? '-' : '';
  return `${sign}${symbol}${whole.toLocaleString('en-US')}`;
}

/**
 * Plain grouped integer for non-monetary counts, matching how the supplied
 * admin.html renders the "Total users" and "Active investments" cards
 * ("1,284", "426" — no currency symbol).
 */
export function formatCount(value) {
  if (value === null || value === undefined) return null;
  return Math.round(Number(value)).toLocaleString('en-US');
}
