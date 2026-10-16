/**
 * CUSTOMER authentication.
 *
 * Same transport model and same security properties as the admin middleware in
 * `./authenticate.js`, but a completely separate token domain:
 *
 *  - audience is `JWT_CUSTOMER_AUDIENCE` (default `scalpsphere-customer`), so a
 *    token minted for the admin panel is rejected here, and a customer token is
 *    rejected by the admin `authenticate` middleware. Neither side can borrow
 *    the other's session even though both share one signing secret.
 *  - cookie names are `cust_access_token` / `cust_refresh_token`, so an
 *    administrator and a customer signed in to the same browser do not clobber
 *    each other's sessions.
 *  - the principal is resolved against `users` (via `customer_auth` for the
 *    credential state), never from a request parameter.
 *
 * `req.customerAuth` (not `req.auth`) is attached so that no admin route can
 * accidentally treat a customer as an administrator, and so no customer route can
 * read admin-only fields such as `role`.
 */
import { env } from '../config/env.js';
import { unauthorized, forbidden } from '../lib/ApiError.js';
import { verifyCustomerAccessToken } from '../lib/tokens.js';

export const CUST_ACCESS_COOKIE_NAME = 'cust_access_token';
export const CUST_REFRESH_COOKIE_NAME = 'cust_refresh_token';

/**
 * Web-session cookie for the FORM-COMPATIBLE flow (POST /login). The live
 * product posts a classic HTML form with redirects rather than a JSON API, so
 * this flow sets a single httpOnly cookie carrying the same signed customer
 * access token. authenticateCustomer accepts it alongside the API cookie.
 */
export const WEB_SESSION_COOKIE = 'web_session';

function bearerFrom(req) {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

/**
 * Hard authentication for every customer route.
 *
 * Resolves the customer's `user_id` from the signed token ONLY. The route never
 * receives, and can never override, an identity parameter — account isolation is
 * a property of this middleware, not of each handler remembering to check.
 */
export function authenticateCustomer({ repos }) {
  return async function authenticateCustomerMiddleware(req, _res, next) {
    try {
      // Three transports: bearer header, the JSON-API cookie, and the
      // form-compatible web-session cookie set by POST /login (the
      // Laravel-style flow). All resolve to the same signed customer token.
      const token = bearerFrom(req)
        ?? req.cookies?.[CUST_ACCESS_COOKIE_NAME]
        ?? req.cookies?.[WEB_SESSION_COOKIE];

      if (!token) {
        throw unauthorized('Missing authentication credentials.');
      }

      let claims;
      try {
        claims = verifyCustomerAccessToken(token);
      } catch (err) {
        if (err.name === 'TokenExpiredError') {
          throw unauthorized('Access token has expired.', { reason: 'token_expired' });
        }
        throw unauthorized('Access token is invalid.', { reason: 'token_invalid' });
      }

      // Claims.sub is the users.id minted at sign-in. It is not a value the
      // client can influence: it comes from the signed token.
      const user = await repos.userRepo.findById(claims.sub);
      if (!user) {
        throw unauthorized('Session subject no longer exists.', { reason: 'subject_missing' });
      }
      if (user.status !== 'active') {
        throw forbidden('This account is not active.');
      }

      // A customer may have portal credentials disabled independently of the
      // admin-managed user record, e.g. pending review.
      const cred = await repos.customerAuthRepo.findByUserId(user.id);
      if (!cred || cred.status !== 'active') {
        throw forbidden('Portal access is not enabled for this account.');
      }

      req.customerAuth = {
        userId: user.id,
        email: user.email,
        transport: bearerFrom(req) ? 'bearer' : 'cookie',
      };
      return next();
    } catch (err) {
      return next(err);
    }
  };
}

/** Cookie options for the customer portal, mirroring the admin ones. */
export function custRefreshCookieOptions() {
  return {
    httpOnly: true,
    secure: env.cookies.secure,
    sameSite: env.cookies.sameSite,
    domain: env.cookies.domain,
    // Scoped to the customer auth path so a stolen cookie is less useful and a
    // logout cannot accidentally clear admin state.
    path: `${env.apiBasePath}/customer/auth`,
  };
}

export function custAccessCookieOptions() {
  return {
    httpOnly: true,
    secure: env.cookies.secure,
    sameSite: env.cookies.sameSite,
    domain: env.cookies.domain,
    path: env.apiBasePath,
  };
}
