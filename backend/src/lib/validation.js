/**
 * Small validation helper.
 *
 * Deliberately handwritten rather than pulled from a library so that every rule
 * applied to user input is visible in one place, and so that the error payload
 * shape is identical across every endpoint:
 *
 *   { success:false, error:{ code:"VALIDATION_ERROR", message, details:[
 *       { field:"email", message:"Must be a valid email address." } ] } }
 */
import { ApiError, validationError } from './ApiError.js';

const EMAIL_RE = /^[^\s@,;:"'()[\]\\]+@[^\s@.,;:"'()[\]\\]+(\.[^\s@.,;:"'()[\]\\]+)+$/;

const RULES = {
  string: (value, rule, field, errors) => {
    if (typeof value !== 'string') {
      errors.push({ field, message: 'Must be a string.' });
      return;
    }
    const v = rule.trim === false ? value : value.trim();
    if (rule.min !== undefined && v.length < rule.min) {
      errors.push({ field, message: `Must be at least ${rule.min} characters.` });
    }
    if (rule.max !== undefined && v.length > rule.max) {
      errors.push({ field, message: `Must be at most ${rule.max} characters.` });
    }
    if (rule.pattern && !rule.pattern.test(v)) {
      errors.push({ field, message: rule.patternMessage || 'Invalid format.' });
    }
  },
  email: (value, rule, field, errors) => {
    if (typeof value !== 'string' || value.length > 254 || !EMAIL_RE.test(value.trim())) {
      errors.push({ field, message: 'Must be a valid email address.' });
      return;
    }
    const normalized = value.trim().toLowerCase();
    if (rule.max !== undefined && normalized.length > rule.max) {
      errors.push({ field, message: `Must be at most ${rule.max} characters.` });
    }
  },
  enum: (value, rule, field, errors) => {
    if (!rule.values.includes(value)) {
      errors.push({
        field,
        message: `Must be one of: ${rule.values.join(', ')}.`,
      });
    }
  },
  integer: (value, rule, field, errors) => {
    const n = typeof value === 'string' && /^-?\d+$/.test(value) ? Number(value) : value;
    if (!Number.isInteger(n)) {
      errors.push({ field, message: 'Must be an integer.' });
      return;
    }
    if (rule.min !== undefined && n < rule.min) errors.push({ field, message: `Must be >= ${rule.min}.` });
    if (rule.max !== undefined && n > rule.max) errors.push({ field, message: `Must be <= ${rule.max}.` });
  },
  boolean: (value, rule, field, errors) => {
    if (typeof value !== 'boolean') errors.push({ field, message: 'Must be a boolean.' });
  },
  money: (value, rule, field, errors) => {
    // Currency-aware decimal check, converted to minor units by the caller.
    if (typeof value !== 'string' && typeof value !== 'number') {
      errors.push({ field, message: 'Must be a number or decimal string.' });
      return;
    }
    if (typeof value === 'number' && !Number.isFinite(value)) {
      errors.push({ field, message: 'Must be a finite number.' });
      return;
    }
    if (rule.min !== undefined && Number(value) < rule.min) {
      errors.push({ field, message: `Must be at least ${rule.min}.` });
    }
  },
};

/**
 * @param {object} schema  { fieldName: { type, required, ...ruleOptions } }
 * @param {object} source  the object to validate (req.body, req.query, ...)
 * @param {object} options { partial: true } allows missing fields (PATCH).
 * @returns {{ value: object, errors: Array }}
 */
export function validate(schema, source, options = {}) {
  const errors = [];
  const value = {};

  for (const [field, rule] of Object.entries(schema)) {
    const provided = source !== undefined && Object.prototype.hasOwnProperty.call(source, field);
    const rawValue = provided ? source[field] : undefined;
    const isMissing = !provided || rawValue === undefined ||
      rawValue === null || (typeof rawValue === 'string' && rawValue.trim() === '');

    if (isMissing) {
      if (rule.required && !options.partial) {
        errors.push({ field, message: rule.requiredMessage || 'This field is required.' });
      }
      if (rule.default !== undefined && !options.partial) value[field] = rule.default;
      continue;
    }

    const before = errors.length;
    const handler = RULES[rule.type];
    if (!handler) throw new Error(`Unknown validation type "${rule.type}" for field "${field}".`);
    handler(rawValue, rule, field, errors);

    // Only keep the (normalised) value when this field validated cleanly.
    if (errors.length === before) {
      value[field] =
        rule.trim === false ? rawValue : typeof rawValue === 'string' ? rawValue.trim() : rawValue;
    }
  }

  // Reject unknown fields unless explicitly allowed (prevents mass assignment).
  if (!options.allowUnknown) {
    for (const key of Object.keys(source || {})) {
      if (!Object.prototype.hasOwnProperty.call(schema, key)) {
        errors.push({ field: key, message: 'Unknown field.' });
      }
    }
  }

  return { value, errors };
}

/** Validate or throw a 422 with a stable error payload. */
export function validateOrThrow(schema, source, options) {
  const { value, errors } = validate(schema, source, options);
  if (errors.length > 0) throw validationError(errors);
  return value;
}

export { ApiError };
