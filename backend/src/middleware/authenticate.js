/**
 * Authentication.
 *
 * Two transports, both verified the same way:
 *
 *  1. `Authorization: Bearer <access-jwt>`  — preferred for API clients and for
 *     a fetch() call that sets a header explicitly.
 *  2. `access_token` httpOnly cookie          — preferred by a browser SPA that
 *     cannot attach the header to every request.
 *
 * The signed JWT carries only non-sensitive claims (sub, email, role, name).
 * The refresh token is opaque, random, and stored only as a SHA-256 hash, so a
 * database disclosure does not leak usable sessions.
 *
 * If the access token is expired but a valid refresh cookie is present, the
 * request is rejected with 401 `TOKEN_EXPIRED` and the client calls
 * `/auth/refresh`. No silent upgrade happens in middleware: every authenticated
 * code path therefore sees a verified, unexpired principal.
 */
import { env } from '../config/env.js';
import { unauthorized, forbidden } from '../lib/ApiError.js';
import { verifyAccessToken } from '../lib/tokens.js';

export const ACCESS_COOKIE_NAME = 'access_token';
export const REFRESH_COOKIE_NAME = 'refresh_token';

function bearerFrom(req) {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

export function authenticate(repos) {
  return async function authenticateMiddleware(req, _res, next) {
    try {
      const token = bearerFrom(req) ?? req.cookies?.[ACCESS_COOKIE_NAME];

      if (!token) {
        throw unauthorized('Missing authentication credentials.');
      }

      let claims;
      try {
        claims = verifyAccessToken(token);
      } catch (err) {
        if (err.name === 'TokenExpiredError') {
          throw unauthorized('Access token has expired.', { reason: 'token_expired' });
        }
        throw unauthorized('Access token is invalid.', { reason: 'token_invalid' });
      }

      const admin = await repos.adminRepo.findById(claims.sub);
      if (!admin) {
        throw unauthorized('Session subject no longer exists.', { reason: 'subject_missing' });
      }
      if (admin.status !== 'active') {
        throw forbidden('This administrator account is disabled.');
      }

      req.auth = {
        adminId: admin.id,
        email: admin.email,
        role: admin.role,
        transport: bearerFrom(req) ? 'bearer' : 'cookie',
      };
      return next();
    } catch (err) {
      return next(err);
    }
  };
}

/**
 * Optional authentication — attaches `req.auth` when a valid token is present
 * but never rejects. Used by `/health` so it can report whether the caller is
 * an authenticated administrator without failing for anonymous probes.
 */
export function optionalAuthenticate(repos) {
  return async function optionalMiddleware(req, _res, next) {
    const token =
      (typeof req.headers.authorization === 'string' &&
        /^bearer\s+/i.test(req.headers.authorization)
          ? req.headers.authorization.replace(/^bearer\s+/i, '').trim()
          : null) ?? req.cookies?.[ACCESS_COOKIE_NAME];

    if (!token) return next();
    try {
      const claims = verifyAccessToken(token);
      const admin = await repos.adminRepo.findById(claims.sub);
      if (admin && admin.status === 'active') {
        req.auth = {
          adminId: admin.id,
          email: admin.email,
          role: admin.role,
          transport: 'bearer',
        };
      }
    } catch {
      /* ignore — optional auth must never fail the request */
    }
    return next();
  };
}

export function requireRole(...roles) {
  return (req, _res, next) => {
    if (!req.auth) return next(unauthorized());
    if (!roles.includes(req.auth.role)) {
      return next(forbidden('This action requires a higher privilege level.'));
    }
    return next();
  };
}

export function refreshCookieOptions() {
  return {
    httpOnly: true,
    secure: env.cookies.secure,
    sameSite: env.cookies.sameSite,
    domain: env.cookies.domain,
    path: `${env.apiBasePath}/auth`,
  };
}

export function accessCookieOptions() {
  return {
    httpOnly: true,
    secure: env.cookies.secure,
    sameSite: env.cookies.sameSite,
    domain: env.cookies.domain,
    path: env.apiBasePath,
  };
}

export function csrfCookieOptions() {
  return {
    httpOnly: false, // readable by design: double-submit pattern
    secure: env.cookies.secure,
    sameSite: env.cookies.sameSite,
    domain: env.cookies.domain,
    path: '/',
  };
}
