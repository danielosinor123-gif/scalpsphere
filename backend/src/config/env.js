/**
 * Environment loading + validation.
 *
 * Startup MUST fail loudly and completely when required configuration is
 * missing. There is no insecure fallback for any security-relevant value.
 */
import dotenv from 'dotenv';

// DOTENV_CONFIG_PATH lets a caller point at a different env file (or a
// nonexistent one, which the configuration tests use to stay hermetic when a
// real .env exists in the repository). Existing environment variables always win
// over anything in the file.
dotenv.config({
  path: process.env.DOTENV_CONFIG_PATH && process.env.DOTENV_CONFIG_PATH.length > 0
    ? process.env.DOTENV_CONFIG_PATH
    : undefined,
});

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);
const FALSY = new Set(['0', 'false', 'no', 'off', '']);

const NODE_ENVIRONMENTS = ['development', 'test', 'production'];

class EnvError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EnvError';
  }
}

function raw(name, fallback = undefined) {
  const v = process.env[name];
  return v === undefined || v === null || v === '' ? fallback : v;
}

/** Required in every environment. */
function mandatory(name) {
  const v = raw(name);
  if (v === undefined) {
    throw new EnvError(`Missing required environment variable: ${name}`);
  }
  return v;
}

function oneOf(name, value, allowed) {
  if (!allowed.includes(value)) {
    throw new EnvError(
      `Invalid ${name}="${value}". Expected one of: ${allowed.join(', ')}.`,
    );
  }
  return value;
}

function parseBool(name, value, fallback) {
  if (value === undefined) return fallback;
  const v = String(value).trim().toLowerCase();
  if (TRUTHY.has(v)) return true;
  if (FALSY.has(v)) return false;
  throw new EnvError(`Invalid boolean for ${name}: "${value}".`);
}

function parseIntInRange(name, value, { min, max, fallback }) {
  if (value === undefined) {
    if (fallback === undefined) throw new EnvError(`Missing ${name}.`);
    return fallback;
  }
  const n = Number.parseInt(String(value), 10);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new EnvError(
      `Invalid ${name}="${value}". Expected an integer between ${min} and ${max}.`,
    );
  }
  return n;
}

function parseCsv(name, value) {
  if (value === undefined) return [];
  return String(value)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Load and validate the configuration. Throws an EnvError listing *all*
 * problems at once so operators do not have to fix them one by one.
 */
export function loadEnv(processEnv = process.env) {
  const problems = [];
  const read = (name) => {
    const v = processEnv[name];
    return v === undefined || v === null || v === '' ? undefined : v;
  };

  const nodeEnv = read('NODE_ENV') ?? 'development';
  try {
    oneOf('NODE_ENV', nodeEnv, NODE_ENVIRONMENTS);
  } catch (err) {
    problems.push(err.message);
  }
  const isProduction = nodeEnv === 'production';
  const isTest = nodeEnv === 'test';

  const collect = (fn) => {
    try {
      return fn();
    } catch (err) {
      if (err instanceof EnvError) problems.push(err.message);
      else throw err;
      return undefined;
    }
  };

  const port = collect(() =>
    parseIntInRange('PORT', read('PORT'), { min: 1, max: 65535, fallback: 4000 }),
  );

  const corsOrigins = collect(() => parseCsv('CORS_ALLOWED_ORIGINS', read('CORS_ALLOWED_ORIGINS')));

  const cookieSameSite = collect(() =>
    oneOf('COOKIE_SAMESITE', read('COOKIE_SAMESITE') ?? 'strict', [
      'strict',
      'lax',
      'none',
    ]),
  );

  const logLevel = collect(() =>
    oneOf('LOG_LEVEL', (read('LOG_LEVEL') ?? 'info').toLowerCase(), [
      'error',
      'warn',
      'info',
      'debug',
    ]),
  );

  const jwtSecret = read('JWT_ACCESS_SECRET');
  if (!jwtSecret) {
    problems.push(
      'Missing required environment variable: JWT_ACCESS_SECRET. ' +
        'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'base64url\'))"',
    );
  } else if (jwtSecret.length < 32) {
    problems.push(
      `JWT_ACCESS_SECRET is too short (${jwtSecret.length} characters). Use at least 32 characters.`,
    );
  }

  // --- Rules -------------------------------------------------------------
  if (isProduction && corsOrigins.length === 0) {
    problems.push(
      'CORS_ALLOWED_ORIGINS must list at least one explicit origin when NODE_ENV=production. ' +
        'Wildcard origins are not allowed because the API authenticates with cookies.',
    );
  }
  if (corsOrigins.includes('*')) {
    problems.push(
      'CORS_ALLOWED_ORIGINS must not contain "*". List each allowed origin explicitly.',
    );
  }
  if (cookieSameSite === 'none' && !isProduction) {
    // allowed, but warn via validation only in production paths
  }

  const dbDriver = collect(() =>
    oneOf('DB_DRIVER', (read('DB_DRIVER') ?? 'mysql').toLowerCase(), ['mysql', 'memory']),
  );

  if (dbDriver === 'memory' && !isTest) {
    problems.push(
      'DB_DRIVER=memory is only permitted when NODE_ENV=test. The in-process store is not durable. ' +
        'Use DB_DRIVER=mysql for development and production.',
    );
  }

  const cookieSecureDefaulted = read('COOKIE_SECURE') === undefined;
  const cookieSecure = collect(() =>
    parseBool('COOKIE_SECURE', read('COOKIE_SECURE'), isProduction),
  );
  if (isProduction && cookieSecureDefaulted) {
    // default already true — nothing to do
  }
  if (cookieSameSite === 'none' && cookieSecure === false) {
    problems.push('COOKIE_SAMESITE=none requires COOKIE_SECURE=true.');
  }

  const dbPassword = read('DB_PASSWORD');
  if (isProduction) {
    const bcryptRounds = Number.parseInt(String(processEnv.BCRYPT_ROUNDS ?? '12'), 10);
    if (!Number.isInteger(bcryptRounds) || bcryptRounds < 10) {
      problems.push(
        'BCRYPT_ROUNDS must be at least 10 when NODE_ENV=production (12 recommended).',
      );
    }
    if (String(processEnv.JWT_ACCESS_TTL ?? '15m').trim() === '0s') {
      problems.push('JWT_ACCESS_TTL must not be zero.');
    }
    if (dbDriver === 'mysql' && (dbPassword === undefined || dbPassword === '')) {
      // A passwordless local socket account is legitimate for development, but
      // it must never happen in production.
      problems.push(
        'DB_PASSWORD is required when NODE_ENV=production. Create a dedicated, ' +
          'least-privileged MySQL user for the application.',
      );
    }
  }

  if (problems.length > 0) {
    throw new EnvError(
      `Invalid configuration (${problems.length} problem(s)):\n` +
        problems.map((p) => `  - ${p}`).join('\n'),
    );
  }

  return {
    nodeEnv,
    isProduction,
    isTest,
    port,
    host: read('HOST') ?? (isProduction ? '0.0.0.0' : '127.0.0.1'),
    apiOrigin: read('API_ORIGIN') ?? `http://localhost:${port}`,
    corsAllowedOrigins: corsOrigins,
    corsCredentials: true,
    trustProxy: read('TRUST_PROXY') ?? 'loopback',
    apiBasePath: read('API_BASE_PATH') ?? '/api/v1',

    db: {
      driver: dbDriver,
      host: read('DB_HOST') ?? '127.0.0.1',
      port: parseIntInRange('DB_PORT', read('DB_PORT'), { min: 1, max: 65535, fallback: 3306 }),
      user: read('DB_USER') ?? 'root',
      password: dbPassword ?? '',
      database: read('DB_NAME') ?? 'scalpsphere',
      poolSize: parseIntInRange('DB_POOL_SIZE', read('DB_POOL_SIZE'), { min: 1, max: 100, fallback: 10 }),
      connectTimeoutMs: parseIntInRange('DB_CONNECT_TIMEOUT_MS', read('DB_CONNECT_TIMEOUT_MS'), {
        min: 1000,
        max: 600000,
        fallback: 10000,
      }),
      ssl: parseBool('DB_SSL', read('DB_SSL'), false),
      charset: read('DB_CHARSET') ?? 'utf8mb4',
    },

    auth: {
      jwtSecret: jwtSecret,
      issuer: read('JWT_ISSUER') ?? 'scalpsphere',
      audience: read('JWT_AUDIENCE') ?? 'scalpsphere-admin',
      // Separate audience for the customer portal. This is the boundary that
      // keeps the two token domains from crossing: `jsonwebtoken` rejects a
      // token whose `aud` does not match, so a customer token can never call an
      // admin route and an admin token can never call a customer route.
      customerAudience: read('JWT_CUSTOMER_AUDIENCE') ?? 'scalpsphere-customer',
      accessTtl: read('JWT_ACCESS_TTL') ?? '15m',
      refreshTtlDays: parseIntInRange('REFRESH_TOKEN_TTL_DAYS', read('REFRESH_TOKEN_TTL_DAYS'), {
        min: 1,
        max: 90,
        fallback: 30,
      }),
      bcryptRounds: parseIntInRange('BCRYPT_ROUNDS', read('BCRYPT_ROUNDS'), { min: 4, max: 15, fallback: 12 }),
      loginMaxAttempts: parseIntInRange('LOGIN_MAX_ATTEMPTS', read('LOGIN_MAX_ATTEMPTS'), {
        min: 3,
        max: 50,
        fallback: 8,
      }),
      loginLockoutMinutes: parseIntInRange('LOGIN_LOCKOUT_MINUTES', read('LOGIN_LOCKOUT_MINUTES'), {
        min: 1,
        max: 1440,
        fallback: 15,
      }),
    },

    cookies: {
      secure: cookieSecure,
      domain: read('COOKIE_DOMAIN') || undefined,
      sameSite: cookieSameSite,
    },

    rateLimit: {
      loginMax: parseIntInRange('RATE_LIMIT_LOGIN_MAX', read('RATE_LIMIT_LOGIN_MAX'), {
        min: 1,
        max: 1000,
        fallback: 8,
      }),
      loginWindowMs: parseIntInRange('RATE_LIMIT_LOGIN_WINDOW_MS', read('RATE_LIMIT_LOGIN_WINDOW_MS'), {
        min: 1000,
        max: 3600000,
        fallback: 900000,
      }),
      apiMax: parseIntInRange('RATE_LIMIT_API_MAX', read('RATE_LIMIT_API_MAX'), {
        min: 1,
        max: 100000,
        // 3000 per 15 min = 200/min. An admin dashboard fires several API calls
        // per screen (summary + list + facets), so a lower ceiling would
        // throttle a single working administrator. This still blocks scraping.
        fallback: 3000,
      }),
      apiWindowMs: parseIntInRange('RATE_LIMIT_API_WINDOW_MS', read('RATE_LIMIT_API_WINDOW_MS'), {
        min: 1000,
        max: 3600000,
        fallback: 900000,
      }),
      writeMax: parseIntInRange('RATE_LIMIT_WRITE_MAX', read('RATE_LIMIT_WRITE_MAX'), {
        min: 1,
        max: 100000,
        fallback: 120,
      }),
      writeWindowMs: parseIntInRange('RATE_LIMIT_WRITE_WINDOW_MS', read('RATE_LIMIT_WRITE_WINDOW_MS'), {
        min: 1000,
        max: 3600000,
        fallback: 900000,
      }),
    },

    log: {
      level: logLevel,
      format: (read('LOG_FORMAT') ?? 'json').toLowerCase(),
    },

    seed: {
      allowInProduction: parseBool('SEED_ALLOW_IN_PRODUCTION', read('SEED_ALLOW_IN_PRODUCTION'), false),
    },
  };
}

/** The validated configuration for this process. Throws on misconfiguration. */
export const env = loadEnv();

export { EnvError };
