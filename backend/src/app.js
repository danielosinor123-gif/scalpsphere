/**
 * Express application factory.
 *
 * Built as a factory (rather than at import time) so the test suite can build
 * an app against an isolated in-memory database on an ephemeral port, and so
 * the production server can build one against MySQL.
 *
 * Middleware order matters and is deliberate:
 *   parse → context → log → security headers → CORS → rate limit → CSRF
 *   → authenticate → route handlers → 404 → error handler
 */
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';

import { env } from './config/env.js';
import { requestLogger } from './lib/logger.js';
import { requestContext } from './middleware/requestContext.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { authenticate, optionalAuthenticate, requireRole } from './middleware/authenticate.js';
import { csrfProtection } from './middleware/csrf.js';
import {
  apiRateLimiter, writeRateLimiter, loginRateLimiter,
} from './middleware/rateLimiters.js';

import { createHealthModule } from './modules/health/health.routes.js';
import { createAuthModule } from './modules/auth/auth.routes.js';
import { createDashboardModule } from './modules/dashboard/dashboard.routes.js';
import { createUsersModule } from './modules/users/users.routes.js';
import { createWithdrawalsModule } from './modules/withdrawals/withdrawals.routes.js';
import { createPaymentMethodsModule } from './modules/paymentMethods/paymentMethods.routes.js';
import { createSettingsModule } from './modules/settings/settings.routes.js';
import { createAuditModule } from './modules/audit/audit.routes.js';
import { createAuditService } from './modules/audit/audit.service.js';
import { createCustomerModule } from './modules/customer/customer.routes.js';
import { forbidden } from './lib/ApiError.js';

const UNSAFE_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

export function createApp({ db }) {
  const app = express();

  // Never advertise the framework or its version.
  app.disable('x-powered-by');

  // Correct client IP resolution for the rate limiter. See .env.example.
  app.set('trust proxy', env.trustProxy);

  // --- Body parsing ---------------------------------------------------------
  app.use(express.json({ limit: '64kb' }));
  app.use(express.urlencoded({ extended: false, limit: '64kb' }));
  app.use(cookieParser());

  // --- Request context + structured logging --------------------------------
  app.use(requestContext);
  app.use(requestLogger);

  // --- Security headers ----------------------------------------------------
  app.use(
    helmet({
      // This service serves JSON only; the static pages are served by the web
      // server / same-origin frontend, so a CSP here has nothing to restrict.
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: 'same-site' },
      referrerPolicy: { policy: 'no-referrer' },
      hsts: env.isProduction ? { maxAge: 31536000, includeSubDomains: true } : false,
    }),
  );

  // --- CORS: explicit allow-list, credentials enabled ----------------------
  if (env.corsAllowedOrigins.length > 0) {
    app.use(
      cors({
        origin(origin, callback) {
          // No Origin header: same-origin navigation or a non-browser client.
          if (!origin) return callback(null, true);
          if (env.corsAllowedOrigins.includes(origin)) return callback(null, true);
          return callback(forbidden(`Origin "${origin}" is not allowed by CORS policy.`));
        },
        credentials: env.corsCredentials,
        methods: ['GET', 'HEAD', 'OPTIONS', 'POST', 'PATCH', 'PUT', 'DELETE'],
        allowedHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Token', 'X-Requested-With'],
        exposedHeaders: ['X-Request-Id', 'Retry-After'],
        maxAge: 600,
      }),
    );
  }

  // --- Rate limiting --------------------------------------------------------
  app.use(env.apiBasePath, apiRateLimiter);

  // --- CSRF protection on unsafe methods -----------------------------------
  app.use(env.apiBasePath, csrfProtection);

  // --- Repositories and services -------------------------------------------
  const repos = db.repositories;
  const audit = createAuditService(repos);
  const requireAdminRole = requireRole;

  // --- Routes ---------------------------------------------------------------
  const api = express.Router();

  // Populates `req.auth` whenever a valid ADMIN access token is present, without
  // rejecting. This is what lets `/auth/me` and `/auth/logout` recognise an
  // already-authenticated caller while `/auth/login` stays public. A customer
  // token has a different audience and is deliberately ignored here.
  api.use(optionalAuthenticate(repos));

  // Dedicated sign-in limiter for BOTH login surfaces: per IP + submitted
  // email, counting only FAILED attempts so routine sign-ins are never blocked.
  // (Previously this limiter was exported but never wired up — the generic API
  // limiter was the only thing protecting sign-in.)
  api.use(['/auth/login', '/customer/auth/login'], loginRateLimiter);

  // Public: health and authentication (exempt from `authenticate` by design).
  createHealthModule(db, (req, _res, next) => next())(api);
  createAuthModule({ repos, audit })(api);

  // Customer portal. Shares `users`, `withdrawals`, `payment_methods` and the
  // settings singleton with the admin panel; tokens are audience-separated so
  // neither side can call the other's routes. Must be registered BEFORE the
  // admin `authenticate` guard below, which would otherwise reject it.
  createCustomerModule({ repos, settings: repos.settingsRepo })(api);

  // All routes below require an authenticated administrator.
  api.use(authenticate(repos));
  api.use((req, res, next) => {
    if (UNSAFE_METHODS.has(req.method)) return writeRateLimiter(req, res, next);
    return next();
  });

  createDashboardModule({ repos, settings: repos.settingsRepo })(api);
  createUsersModule({ repos, settings: repos.settingsRepo })(api);
  createWithdrawalsModule({ repos, settings: repos.settingsRepo })(api);
  createPaymentMethodsModule({ repos, audit, requireAdminRole })(api);
  createSettingsModule({ repos, audit, requireAdminRole })(api);
  createAuditModule({ repos, requireAdminRole })(api);

  app.use(env.apiBasePath, api);

  // --- 404 + error envelope -------------------------------------------------
  app.use(notFoundHandler);
  app.use(errorHandler);

  // Exposed for tests and for the host process to shut down deterministically.
  app.locals.db = db;
  app.locals.csrfCookieName = 'csrf_token';

  return app;
}
