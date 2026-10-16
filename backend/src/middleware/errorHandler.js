/**
 * Error handling and 404s.
 *
 * Contract:
 *   4xx/503 → the exact ApiError envelope produced by the route/service.
 *   5xx     → a generic envelope. The real error is logged server-side with the
 *             request id, and NEVER returned to the client: no stack traces,
 *             no SQL, no driver messages, no secrets.
 */
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { ApiError, internal, serviceUnavailable } from '../lib/ApiError.js';
import { notFound } from '../lib/ApiError.js';

const KNOWN_CODES = new Set([
  'ER_DUP_ENTRY',
  'ER_NO_REFERENCED_ROW_2',
  'ER_ROW_IS_REFERENCED_2',
  'ER_CHECK_CONSTRAINT_VIOLATED',
  'ER_DATA_TOO_LONG',
  'ER_TRUNCATED_WRONG_VALUE',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'ER_ACCESS_DENIED_ERROR',
  'ER_LOCK_DEADLOCK',
  'ER_LOCK_WAIT_TIMEOUT',
  'ER_CONSTRAINT',
]);

function looksOperational(err) {
  return err.isOperational === true || KNOWN_CODES.has(err.code) || err.constraint === true;
}

export function notFoundHandler(req, _res, next) {
  next(notFound(`No route for ${req.method} ${req.originalUrl}.`));
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  let apiError = err;

  if (!(err instanceof ApiError)) {
    // Malformed JSON bodies from express.json() and friends.
    if (err?.type === 'entity.parse.failed' || err?.name === 'SyntaxError') {
      apiError = new ApiError(400, 'MALFORMED_JSON', 'Request body is not valid JSON.');
    } else if (err?.type === 'entity.too.large') {
      apiError = new ApiError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large.');
    } else if (err?.status >= 400 && err?.status < 500 && err?.expose) {
      apiError = err;
    } else if (looksOperational(err)) {
      apiError = err.status === 404 ? notFound() : internal();
    } else {
      apiError = internal();
    }
  }

  const payload = {
    code: apiError.code ?? 'INTERNAL_ERROR',
    message:
      apiError.status >= 500 ? 'An unexpected error occurred. Please try again later.' : apiError.message,
    request_id: req.id,
    ...(apiError.details ? { details: apiError.details } : {}),
  };

  if (apiError.status >= 500) {
    logger.error('unhandled_error', {
      request_id: req.id,
      method: req.method,
      path: req.originalUrl,
      status: apiError.status ?? 500,
      code: apiError.code,
      error_name: err?.name,
      error_message: err?.message,
      stack: env.isProduction ? undefined : err?.stack,
    });
  } else if (apiError.status >= 400 && apiError.status !== 404) {
    logger.warn('request_rejected', {
      request_id: req.id,
      method: req.method,
      path: req.originalUrl,
      status: apiError.status,
      code: apiError.code,
    });
  }

  res.status(apiError.status ?? 500).json({ success: false, error: payload });
}

/** Last-resort handler: guarantees an uncaught throw still yields JSON. */
export function finalErrorGuard(err, req, res, _next) {
  logger.error('uncaught_exception_in_request', {
    request_id: req.id,
    error_message: err?.message,
    stack: env.isProduction ? undefined : err?.stack,
  });
  if (!res.headersSent) {
    res.status(503).json({
      success: false,
      error: {
        code: 'SERVICE_UNAVAILABLE',
        message: 'The service could not complete this request.',
        request_id: req.id,
      },
    });
  }
}

export { serviceUnavailable };
