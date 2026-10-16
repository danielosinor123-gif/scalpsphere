/**
 * Session tokens.
 *
 * Access token  : short-lived signed JWT, delivered in the response body AND as
 *                an httpOnly cookie so the browser can use either transport.
 * Refresh token : opaque 384-bit random string, delivered ONLY as an httpOnly
 *                cookie scoped to the refresh path, and persisted as a SHA-256
 *                hash in `admin_sessions`. Rotated on every use.
 */
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { randomToken, sha256 } from './ids.js';

export const ACCESS_TOKEN_TYP = 'access';
export const REFRESH_TOKEN_TYP = 'refresh';
export const CUSTOMER_ACCESS_TOKEN_TYP = 'customer_access';

export function signAccessToken(admin) {
  return jwt.sign(
    {
      sub: admin.id,
      email: admin.email,
      role: admin.role,
      name: admin.full_name,
    },
    env.auth.jwtSecret,
    {
      algorithm: 'HS256',
      expiresIn: env.auth.accessTtl,
      issuer: env.auth.issuer,
      audience: env.auth.audience,
      keyid: 'scalpsphere-access',
    },
  );
}

export function verifyAccessToken(token) {
  return jwt.verify(token, env.auth.jwtSecret, {
    algorithms: ['HS256'],
    issuer: env.auth.issuer,
    audience: env.auth.audience,
  });
}

/**
 * Customer access token. Same secret and issuer, DIFFERENT audience, plus a
 * distinct `typ` claim for defence in depth. `verifyAccessToken` above (used by
 * every admin route) therefore rejects these, and this function rejects admin
 * tokens — so neither domain can borrow the other's session.
 */
export function signCustomerAccessToken(user) {
  return jwt.sign(
    {
      // sub IS the customer's users.id and the sole source of identity on every
      // customer route. It is minted server-side at sign-in and can never be
      // supplied or overridden by a request parameter.
      sub: user.id,
      typ: CUSTOMER_ACCESS_TOKEN_TYP,
      email: user.email,
      name: user.full_name,
    },
    env.auth.jwtSecret,
    {
      algorithm: 'HS256',
      expiresIn: env.auth.accessTtl,
      issuer: env.auth.issuer,
      audience: env.auth.customerAudience,
      keyid: 'scalpsphere-customer-access',
    },
  );
}

export function verifyCustomerAccessToken(token) {
  const claims = jwt.verify(token, env.auth.jwtSecret, {
    algorithms: ['HS256'],
    issuer: env.auth.issuer,
    audience: env.auth.customerAudience,
  });
  if (claims.typ !== CUSTOMER_ACCESS_TOKEN_TYP) {
    const err = new Error('Wrong token type for this audience.');
    err.name = 'JsonWebTokenError';
    throw err;
  }
  return claims;
}

export function createRefreshToken() {
  const token = randomToken(48);
  return {
    token,
    tokenHash: sha256(token),
    expiresAt: new Date(Date.now() + env.auth.refreshTtlDays * 24 * 60 * 60 * 1000),
  };
}

export function hashRefreshToken(token) {
  return sha256(token);
}
