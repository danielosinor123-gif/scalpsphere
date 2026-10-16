/**
 * ApiError + typed helpers for the standard error envelope.
 *
 * Every error response is:
 *   { success: false, error: { code, message, details? , request_id } }
 *
 * No stack traces, no SQL text, no driver errors and no secrets ever leave the
 * process — see middleware/error-handler.js.
 */
export class ApiError extends Error {
  constructor(status, code, message, details = undefined) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.expose = true;
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      ...(this.details ? { details: this.details } : {}),
    };
  }
}

export const badRequest = (message, details) =>
  new ApiError(400, 'BAD_REQUEST', message, details);

export const validationError = (details, message = 'Request validation failed.') =>
  new ApiError(422, 'VALIDATION_ERROR', message, details);

export const unauthorized = (message = 'Authentication required.', details) =>
  new ApiError(401, 'UNAUTHENTICATED', message, details);

export const invalidCredentials = () =>
  new ApiError(401, 'INVALID_CREDENTIALS', 'Incorrect email or password.');

export const accountLocked = (until) =>
  new ApiError(
    423,
    'ACCOUNT_LOCKED',
    'Too many failed sign-in attempts. The account is temporarily locked.',
    until ? { locked_until: until.toISOString() } : undefined,
  );

export const accountDisabled = () =>
  new ApiError(403, 'ACCOUNT_DISABLED', 'This administrator account is disabled.');

export const forbidden = (message = 'You do not have permission to perform this action.') =>
  new ApiError(403, 'FORBIDDEN', message);

export const notFound = (message = 'Resource not found.') =>
  new ApiError(404, 'NOT_FOUND', message);

export const conflict = (message, details) =>
  new ApiError(409, 'CONFLICT', message, details);

export const payloadTooLarge = (message = 'Request payload too large.') =>
  new ApiError(413, 'PAYLOAD_TOO_LARGE', message);

export const tooManyRequests = (message = 'Too many requests. Try again later.', details) =>
  new ApiError(429, 'RATE_LIMITED', message, details);

export const internal = (message = 'An unexpected error occurred.') =>
  new ApiError(500, 'INTERNAL_ERROR', message);

export const serviceUnavailable = (message = 'Service temporarily unavailable.') =>
  new ApiError(503, 'SERVICE_UNAVAILABLE', message);

export const csrfError = (message = 'CSRF token missing or invalid.') =>
  new ApiError(403, 'CSRF_TOKEN_INVALID', message);
