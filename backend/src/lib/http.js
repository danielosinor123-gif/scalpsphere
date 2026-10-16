/** Standard success envelope helpers. Every 2xx response has `success: true`. */
import { ApiError } from './ApiError.js';

export function ok(res, data, meta = undefined) {
  const body = { success: true, data };
  if (meta) body.meta = meta;
  return res.status(200).json(body);
}

export function created(res, data, meta = undefined) {
  const body = { success: true, data };
  if (meta) body.meta = meta;
  return res.status(201).json(body);
}

export function noContent(res) {
  return res.status(204).end();
}

/**
 * Paginated envelope. `pagination` is documented in docs/API_CONTRACT.md and
 * openapi.yaml and is identical on every paginated endpoint.
 */
export function paginated(res, data, pagination, meta = undefined) {
  const body = { success: true, data };
  body.meta = { ...(meta || {}), pagination };
  return res.status(200).json(body);
}

/** Wraps an async handler so rejected promises reach the error middleware. */
export function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

export { ApiError };
