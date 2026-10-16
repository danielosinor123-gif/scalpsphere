/**
 * CSRF protection — double submit cookie.
 *
 * The browser session uses an httpOnly cookie, so every unsafe method
 * (POST / PATCH / PUT / DELETE) must additionally carry the CSRF token issued
 * at login: read from the readable `csrf_token` cookie and echoed in the
 * `X-CSRF-Token` header. A cross-site attacker can cause the cookie to be sent
 * but cannot read it, so they cannot produce the header.
 *
 * Requests that authenticate purely with `Authorization: Bearer <jwt>` and
 * send no session cookie are exempt: they are not ambient-credential requests
 * and therefore not CSRF-able. `POST /auth/login` is exempt (it establishes the
 * session) but is rate limited and username+password protected.
 */
import { safeEqualHex } from '../lib/ids.js';
import { csrfError } from '../lib/ApiError.js';

export const CSRF_COOKIE_NAME = 'csrf_token';
export const CSRF_HEADER_NAME = 'x-csrf-token';

// Both session domains share this CSRF cookie name and header. A browser
// holding an admin session and a customer session at the same time therefore
// presents whichever csrf_token cookie is current, which is exactly the value it
// can read and echo back — the double-submit property holds for both domains.
export const ADMIN_SESSION_COOKIE = 'access_token';
export const CUSTOMER_SESSION_COOKIE = 'cust_access_token';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function toHex(value) {
  return Buffer.from(String(value), 'utf8').toString('hex');
}

export function csrfProtection(req, _res, next) {
  if (SAFE_METHODS.has(req.method)) return next();

  const authHeader = req.headers.authorization;
  const hasBearer = typeof authHeader === 'string' && /^bearer\s+/i.test(authHeader);
  // Either session cookie makes this an ambient-credential request.
  const hasSessionCookie = Boolean(
    req.cookies?.[ADMIN_SESSION_COOKIE] ?? req.cookies?.[CUSTOMER_SESSION_COOKIE],
  );

  // No credential of any kind: let the auth layer answer with 401 rather than
  // confusing an unauthenticated caller with a CSRF error.
  if (!hasSessionCookie && !hasBearer) return next();

  // Bearer-only request (no ambient cookie): not CSRF-able.
  if (hasBearer && !hasSessionCookie) return next();

  // Login establishes the session; no ambient credential exists yet. Both the
  // admin path (/auth/login) and the customer path (/customer/auth/login) end
  // with /auth/login.
  if (req.path.endsWith('/auth/login')) return next();

  const cookieToken = req.cookies?.[CSRF_COOKIE_NAME];
  const headerToken = req.headers[CSRF_HEADER_NAME];

  if (typeof cookieToken !== 'string' || cookieToken.length < 16) {
    return next(csrfError('Missing CSRF cookie. Re-authenticate.'));
  }
  if (typeof headerToken !== 'string' || headerToken.length < 16) {
    return next(csrfError('Missing CSRF token header.'));
  }
  if (!safeEqualHex(toHex(cookieToken), toHex(headerToken))) {
    return next(csrfError('CSRF token mismatch.'));
  }
  return next();
}
