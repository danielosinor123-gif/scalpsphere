/**
 * Authentication module.
 *
 * Endpoints (all public — `authenticate` is NOT applied to this router):
 *   POST /api/v1/auth/login            email + password → session
 *   POST /api/v1/auth/refresh          rotate refresh cookie → new access token
 *   POST /api/v1/auth/logout           revoke current session
 *   POST /api/v1/auth/logout-all       revoke every session for this admin
 *   GET  /api/v1/auth/me               current principal
 *   GET  /api/v1/auth/csrf             issue a CSRF token cookie
 *   POST /api/v1/auth/change-password  authenticated self-service password change
 *
 * Deliberately absent: registration, password reset / email, and any endpoint
 * that lists or creates administrators. See docs/SECURITY.md for the
 * out-of-band provisioning procedure.
 */
import bcrypt from 'bcryptjs';
import { env } from '../../config/env.js';
import { randomToken, sha256, uuid } from '../../lib/ids.js';
import { asyncHandler, ok } from '../../lib/http.js';
import {
  accountLocked,
  accountDisabled,
  invalidCredentials,
  unauthorized,
  validationError,
  badRequest,
} from '../../lib/ApiError.js';
import { validateOrThrow } from '../../lib/validation.js';
import { verifyPassword, hashPassword, passwordPolicyErrors } from '../../lib/password.js';
import { signAccessToken, createRefreshToken } from '../../lib/tokens.js';
import {
  ACCESS_COOKIE_NAME, REFRESH_COOKIE_NAME,
  accessCookieOptions, refreshCookieOptions, csrfCookieOptions,
} from '../../middleware/authenticate.js';
import { CSRF_COOKIE_NAME } from '../../middleware/csrf.js';

const LOGIN_SCHEMA = {
  email: { type: 'email', required: true, max: 254 },
  password: { type: 'string', required: true, min: 1, max: 128, trim: false },
};

const CHANGE_PASSWORD_SCHEMA = {
  current_password: { type: 'string', required: true, min: 1, max: 128, trim: false },
  new_password: { type: 'string', required: true, min: 12, max: 128, trim: false },
};

/**
 * A valid bcrypt-shaped hash of a throwaway random string, used to spend the
 * same CPU time on "no such account" as on "wrong password" so that response
 * latency does not reveal which emails exist.
 */
const DUMMY_HASH = bcrypt.hashSync(randomToken(16), 4);

/** `expires_in` in seconds, derived from the configured access-token TTL. */
function accessTtlSeconds() {
  const match = /^(\d+)([smhd])$/.exec(String(env.auth.accessTtl).trim());
  if (!match) return 900;
  const value = Number(match[1]);
  const unit = { s: 1, m: 60, h: 3600, d: 86400 }[match[2]];
  return value * unit;
}

export function createAuthModule({ repos, audit }) {
  function setAuthCookies(res, { accessToken, refreshToken, csrfToken }) {
    res.cookie(ACCESS_COOKIE_NAME, accessToken, accessCookieOptions());
    res.cookie(REFRESH_COOKIE_NAME, refreshToken, refreshCookieOptions());
    res.cookie(CSRF_COOKIE_NAME, csrfToken, csrfCookieOptions());
  }

  function clearAuthCookies(res) {
    res.clearCookie(ACCESS_COOKIE_NAME, accessCookieOptions());
    res.clearCookie(REFRESH_COOKIE_NAME, refreshCookieOptions());
    res.cookie(CSRF_COOKIE_NAME, '', { ...csrfCookieOptions(), maxAge: 0 });
  }

  async function issueSession(admin, req) {
    const csrfToken = randomToken(32);
    const accessToken = signAccessToken(admin);
    const { token: refreshToken, tokenHash, expiresAt } = createRefreshToken();

    await repos.sessionRepo.create({
      id: uuid(),
      adminId: admin.id,
      refreshTokenHash: tokenHash,
      expiresAt,
      ip: req.clientIp,
      userAgent: req.userAgent,
    });

    return { accessToken, refreshToken, csrfToken, expiresAt };
  }

  function sessionPayload(session, admin) {
    return {
      admin: {
        id: admin.id,
        email: admin.email,
        full_name: admin.full_name,
        role: admin.role,
      },
      access_token: session.accessToken,
      token_type: 'Bearer',
      expires_in: accessTtlSeconds(),
      csrf_token: session.csrfToken,
      session_expires_at: session.expiresAt.toISOString(),
    };
  }

  return function register(router) {
    // -------------------------------------------------------------------
    // Login
    // -------------------------------------------------------------------
    router.post(
      '/auth/login',
      asyncHandler(async (req, res) => {
        const { email, password } = validateOrThrow(LOGIN_SCHEMA, req.body ?? {});
        const admin = await repos.adminRepo.findByEmail(email);

        const passwordMatches = await verifyPassword(
          password,
          admin ? admin.password_hash : DUMMY_HASH,
        );

        if (!admin || !passwordMatches) {
          if (admin) {
            const updated = await repos.adminRepo.recordLoginFailure(
              admin.id,
              env.auth.loginMaxAttempts,
              new Date(Date.now() + env.auth.loginLockoutMinutes * 60 * 1000),
            );
            await audit.record({
              req,
              adminId: null,
              adminEmail: admin.email,
              action: 'auth.login_failed',
              entityType: 'admin',
              entityId: admin.id,
              summary: `Failed sign-in attempt (count ${updated.failed_login_count}).`,
            });
            if (updated.locked_until && new Date(updated.locked_until) > new Date()) {
              throw accountLocked(new Date(updated.locked_until));
            }
          }
          // Never disclose whether the account exists.
          throw invalidCredentials();
        }

        if (admin.status !== 'active') throw accountDisabled();
        if (admin.locked_until && new Date(admin.locked_until) > new Date()) {
          throw accountLocked(new Date(admin.locked_until));
        }

        await repos.adminRepo.recordLoginSuccess(admin.id);
        const session = await issueSession(admin, req);
        setAuthCookies(res, session);

        await audit.record({
          req,
          adminId: admin.id,
          adminEmail: admin.email,
          action: 'auth.login_succeeded',
          entityType: 'admin',
          entityId: admin.id,
          summary: `Administrator signed in (${admin.role}).`,
        });

        return ok(res, sessionPayload(session, admin));
      }),
    );

    // -------------------------------------------------------------------
    // Refresh (rotates the refresh token)
    // -------------------------------------------------------------------
    router.post(
      '/auth/refresh',
      asyncHandler(async (req, res) => {
        const raw = req.cookies?.[REFRESH_COOKIE_NAME];
        if (!raw) throw unauthorized('No refresh token present.');

        const session = await repos.sessionRepo.findValidByTokenHash(sha256(raw), new Date());
        if (!session) throw unauthorized('Refresh token is invalid, expired or revoked.');
        if (new Date(session.expires_at) <= new Date()) {
          throw unauthorized('Refresh token has expired.');
        }

        const admin = await repos.adminRepo.findById(session.admin_id);
        if (!admin || admin.status !== 'active') {
          throw unauthorized('Session subject is no longer valid.');
        }

        await repos.sessionRepo.revoke(session.id, 'rotated', new Date());
        const next = await issueSession(admin, req);
        setAuthCookies(res, next);

        await audit.record({
          req,
          adminId: admin.id,
          adminEmail: admin.email,
          action: 'auth.session_refreshed',
          entityType: 'admin_session',
          entityId: session.id,
          summary: 'Session refreshed; previous refresh token revoked.',
        });

        return ok(res, sessionPayload(next, admin));
      }),
    );

    // -------------------------------------------------------------------
    // Logout
    // -------------------------------------------------------------------
    router.post(
      '/auth/logout',
      asyncHandler(async (req, res) => {
        const raw = req.cookies?.[REFRESH_COOKIE_NAME];
        if (raw) {
          const session = await repos.sessionRepo.findValidByTokenHash(sha256(raw), new Date());
          if (session) {
            await repos.sessionRepo.revoke(session.id, 'logout', new Date());
            await audit.record({
              req,
              adminId: session.admin_id,
              adminEmail: req.auth?.email ?? null,
              action: 'auth.logout',
              entityType: 'admin_session',
              entityId: session.id,
              summary: 'Administrator signed out.',
            });
          }
        }
        clearAuthCookies(res);
        return ok(res, { logged_out: true });
      }),
    );

    router.post(
      '/auth/logout-all',
      asyncHandler(async (req, res) => {
        if (!req.auth) throw unauthorized();
        const n = await repos.sessionRepo.revokeForAdmin(req.auth.adminId, 'logout_all', new Date());
        clearAuthCookies(res);
        await audit.record({
          req,
          adminId: req.auth.adminId,
          adminEmail: req.auth.email,
          action: 'auth.logout_all',
          entityType: 'admin',
          entityId: req.auth.adminId,
          summary: `Revoked ${n} active session(s).`,
        });
        return ok(res, { revoked_sessions: n });
      }),
    );

    // -------------------------------------------------------------------
    // Session introspection / CSRF bootstrap
    // -------------------------------------------------------------------
    router.get(
      '/auth/me',
      asyncHandler(async (req, res) => {
        if (!req.auth) throw unauthorized();
        const admin = await repos.adminRepo.findById(req.auth.adminId);
        if (!admin) throw unauthorized('Session subject no longer exists.');
        return ok(res, {
          id: admin.id,
          email: admin.email,
          full_name: admin.full_name,
          role: admin.role,
          status: admin.status,
          last_login_at: admin.last_login_at ? new Date(admin.last_login_at).toISOString() : null,
        });
      }),
    );

    router.get('/auth/csrf', (req, res) => {
      const token = randomToken(32);
      res.cookie(CSRF_COOKIE_NAME, token, csrfCookieOptions());
      return ok(res, { csrf_token: token, header: CSRF_COOKIE_NAME });
    });

    // -------------------------------------------------------------------
    // Self-service password change
    // -------------------------------------------------------------------
    router.post(
      '/auth/change-password',
      asyncHandler(async (req, res) => {
        if (!req.auth) throw unauthorized();
        const { current_password, new_password } = validateOrThrow(
          CHANGE_PASSWORD_SCHEMA,
          req.body ?? {},
        );
        const policy = passwordPolicyErrors(new_password);
        if (policy.length > 0) {
          throw validationError([{ field: 'new_password', message: policy.join(' ') }]);
        }

        const admin = await repos.adminRepo.findById(req.auth.adminId);
        if (!admin) throw unauthorized();

        const valid = await verifyPassword(current_password, admin.password_hash);
        if (!valid) throw badRequest('Current password is incorrect.');

        const hash = await hashPassword(new_password);
        await repos.adminRepo.setPassword(admin.id, hash);
        await repos.sessionRepo.revokeForAdmin(admin.id, 'password_changed', new Date());

        await audit.record({
          req,
          adminId: admin.id,
          adminEmail: admin.email,
          action: 'auth.password_changed',
          entityType: 'admin',
          entityId: admin.id,
          summary: 'Password changed; all sessions revoked.',
          after: { sessions_revoked: true },
        });

        return ok(res, { password_changed: true, sessions_revoked: true });
      }),
    );

    return router;
  };
}
