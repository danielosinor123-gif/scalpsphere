/**
 * Test environment bootstrap.
 *
 * Called by every test file BEFORE any `src/` module is imported (via
 * `tests/helpers/context.js`), so that `src/config/env.js` sees the test
 * configuration. Node's test runner gives each test file a fresh process.
 *
 * The suite runs with `NODE_ENV=test`. `DB_DRIVER` defaults to `memory` so no
 * MySQL server is required, but an explicit `DB_DRIVER=mysql` is honoured and
 * runs the identical assertions against a real test schema.
 *
 * Node's test runner runs test FILES in parallel by default. Against a shared
 * database that would make the files interfere with each other, so MySQL mode
 * must be run with `--test-concurrency=1` (see the `test:mysql` script).
 */

export function applyTestEnv(overrides = {}) {
  const defaults = {
    NODE_ENV: 'test',
    // Default to the offline driver, but honour an explicit DB_DRIVER=mysql so
    // the documented `DB_DRIVER=mysql npm test` actually works.
    DB_DRIVER: process.env.DB_DRIVER || 'memory',
    HOST: '127.0.0.1',
    PORT: '4000',
    API_ORIGIN: 'http://127.0.0.1:4000',

    CORS_ALLOWED_ORIGINS: 'http://localhost:4000,http://127.0.0.1:4000,http://localhost:5173',

    JWT_ACCESS_SECRET: 'test-only-secret-value-with-enough-entropy-0123456789',
    JWT_ISSUER: 'scalpsphere-test',
    JWT_AUDIENCE: 'scalpsphere-admin-test',
    JWT_ACCESS_TTL: '15m',
    REFRESH_TOKEN_TTL_DAYS: '30',
    BCRYPT_ROUNDS: '4',
    LOGIN_MAX_ATTEMPTS: '8',
    LOGIN_LOCKOUT_MINUTES: '15',

    COOKIE_SECURE: 'false',
    COOKIE_SAMESITE: 'strict',
    API_BASE_PATH: '/api/v1',

    RATE_LIMIT_LOGIN_MAX: '1000',
    RATE_LIMIT_LOGIN_WINDOW_MS: '900000',
    RATE_LIMIT_API_MAX: '100000',
    RATE_LIMIT_API_WINDOW_MS: '900000',
    RATE_LIMIT_WRITE_MAX: '100000',
    RATE_LIMIT_WRITE_WINDOW_MS: '900000',

    LOG_LEVEL: 'error',
    LOG_FORMAT: 'json',
    TRUST_PROXY: 'loopback',

    SEED_ALLOW_IN_PRODUCTION: 'false',
  };

  for (const [key, value] of Object.entries({ ...defaults, ...overrides })) {
    process.env[key] = value;
  }
}
