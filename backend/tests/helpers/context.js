/**
 * Test context: builds the real Express app against an isolated in-memory
 * database, listens on an ephemeral port, and exposes a tiny fetch() client
 * with a cookie jar so cookie-based auth and CSRF can be exercised end to end.
 */
import { applyTestEnv } from './env.js';

let appModule;
let dbModule;
let bcrypt;

async function buildContext(overrides) {
  applyTestEnv(overrides);

  appModule = await import('../../src/app.js');
  dbModule = await import('../../src/db/index.js');
  bcrypt = (await import('bcryptjs')).default;

  const db = await dbModule.createDatabase();
  const app = appModule.createApp({ db });

  // MySQL mode shares one schema across every test file, so each file starts
  // from an empty set of tables. The memory driver is already per-process.
  if (db.dialect === 'mysql') {
    // Hard guard: this path DELETES every application table. Refuse to run it
    // against anything that does not look like a throwaway test schema, so a
    // `.env` pointing at the development or production database cannot be
    // silently wiped by `npm run test:mysql`.
    const { env } = await import('../../src/config/env.js');
    const name = String(env.db.database ?? '').toLowerCase();
    if (!name.includes('test')) {
      throw new Error(
        `Refusing to run the MySQL test suite against "${name}". ` +
          'The suite truncates every application table, so DB_NAME must be a ' +
          'throwaway schema whose name contains "test" (e.g. scalpsphere_test). ' +
          'Override it with DB_NAME=scalpsphere_test.',
      );
    }
    await db.truncateAll();
  }

  const server = await new Promise((resolve, reject) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
    s.once('error', reject);
  });
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  return { app, db, server, baseUrl };
}

export async function createTestContext(overrides = {}) {
  const ctx = await buildContext(overrides);
  const client = createClient(ctx.baseUrl);
  ctx.client = client;
  ctx.close = async () => {
    await new Promise((resolve) => ctx.server.close(resolve));
    await ctx.db.close();
  };
  return ctx;
}

/**
 * Minimal HTTP client with a cookie jar.
 * `cookies` are stored name→value and sent on every subsequent request.
 */
export function createClient(baseUrl) {
  const cookies = new Map();

  function storeCookies(response) {
    for (const raw of response.headers.getSetCookie?.() ?? []) {
      const [pair, ...attrs] = raw.split(';').map((s) => s.trim());
      const eq = pair.indexOf('=');
      const name = pair.slice(0, eq);
      const value = pair.slice(eq + 1);
      const httpOnly = attrs.some((a) => a.toLowerCase() === 'httponly');
      cookies.set(name, { value, httpOnly });
    }
  }

  function cookieHeader() {
    return [...cookies.entries()].map(([name, v]) => `${name}=${v.value}`).join('; ');
  }

  /**
   * @param {string} path   e.g. '/api/v1/users'
   * @param {object} options { method, body, headers, json }
   */
  async function request(path, options = {}) {
    const headers = { ...(options.headers ?? {}) };
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    const cookie = cookieHeader();
    if (cookie) headers.Cookie = cookie;

    const response = await fetch(`${baseUrl}${path}`, {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      redirect: 'manual',
    });

    storeCookies(response);

    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }

    return {
      status: response.status,
      headers: response.headers,
      json,
      text,
      setCookies: response.headers.getSetCookie?.() ?? [],
    };
  }

  const client = {
    get: (path, options) => request(path, { ...options, method: 'GET' }),
    post: (path, body, options) => request(path, { ...options, method: 'POST', body }),
    patch: (path, body, options) => request(path, { ...options, method: 'PATCH', body }),
    put: (path, body, options) => request(path, { ...options, method: 'PUT', body }),
    delete: (path, body, options) => request(path, { ...options, method: 'DELETE', body }),
    request,
    cookies,
    /** Authenticated request that carries the CSRF header from the jar. */
    withCsrf: (method, path, body) =>
      request(path, {
        method,
        body,
        headers: { 'X-CSRF-Token': cookies.get('csrf_token')?.value ?? '' },
      }),
    authWithCsrf: (method, path, body, token) =>
      request(path, {
        method,
        body,
        headers: {
          'X-CSRF-Token': token ?? cookies.get('csrf_token')?.value ?? '',
          Authorization: `Bearer ${token ?? ''}`,
        },
      }),
    clearCookies: () => cookies.clear(),
  };
  return client;
}

/**
 * Seed one administrator and sign in, returning the access token and the
 * cookie jar contents. Uses the memory driver's repositories directly.
 */
export async function createAdminAndLogin(ctx, {
  email = 'root-admin@example.com',
  password = 'Str0ng!Passw0rd#2026',
  fullName = 'Root Owner',
  role = 'owner',
} = {}) {
  const { adminRepo } = ctx.db.repositories;
  const hash = await bcrypt.hash(password, 4);
  const admin = await adminRepo.create({
    id: (await import('node:crypto')).randomUUID(),
    email,
    passwordHash: hash,
    fullName,
    role,
  });

  const login = await ctx.client.post('/api/v1/auth/login', { email, password });
  return {
    admin,
    login,
    accessToken: login.json?.data?.access_token,
    csrfToken: login.json?.data?.csrf_token,
  };
}

/** Seed a payment method directly through the repository. */
export async function seedPaymentMethod(ctx, overrides = {}) {
  const { paymentMethodRepo } = ctx.db.repositories;
  const { randomUUID } = await import('node:crypto');
  return paymentMethodRepo.create({
    id: randomUUID(),
    name: 'Seeded USDT',
    type: 'crypto',
    usedFor: 'both',
    status: 'enabled',
    isDemo: 1,
    ...overrides,
  });
}

/** Seed a demo user + withdrawal pair directly through the repositories. */
export async function seedUserAndWithdrawal(ctx, overrides = {}) {  const { userRepo, withdrawalRepo } = ctx.db.repositories;
  const { randomUUID } = await import('node:crypto');
  const user = await userRepo.create({
    id: randomUUID(),
    fullName: 'Demo Person',
    email: 'demo.person@example.com',
    balanceMinor: 12345,
    status: 'active',
    kycStatus: 'verified',
    isDemo: 1,
    ...(overrides.user ?? {}),
  });
  const withdrawal = await withdrawalRepo.create({
    id: randomUUID(),
    userId: user.id,
    amountMinor: 7777,
    feeMinor: 277,
    method: 'USDT',
    receiverEmail: 'demo.receiver@example.com',
    status: 'pending',
    isDemo: 1,
    ...(overrides.withdrawal ?? {}),
  });
  return { user, withdrawal };
}

/**
 * Seeds a demo user, attaches CUSTOMER portal credentials, and signs in via the
 * real HTTP endpoint. Returns the user row plus the login response, the bearer
 * token and the CSRF token for the customer domain.
 *
 * `overrides.user.email` must be unique per call when seeding several.
 */
export async function createCustomerAndLogin(ctx, overrides = {}) {
  const { randomUUID } = await import('node:crypto');
  const bcrypt = (await import('bcryptjs')).default;
  const { userRepo, withdrawalRepo, customerAuthRepo } = ctx.db.repositories;

  const email = overrides.user?.email ?? `customer-${randomUUID()}@example.com`;
  const user = await userRepo.create({
    id: randomUUID(),
    fullName: 'Demo Customer',
    email,
    balanceMinor: 50000,
    status: 'active',
    kycStatus: 'verified',
    isDemo: 1,
    ...(overrides.user ?? {}),
  });

  if (overrides.withdrawal) {
    await withdrawalRepo.create({
      id: randomUUID(),
      userId: user.id,
      isDemo: 1,
      ...(overrides.withdrawal ?? {}),
    });
  }

  await customerAuthRepo.create({
    userId: user.id,
    passwordHash: await bcrypt.hash(CUSTOMER_PASSWORD, 4),
  });

  // Sign in through the real endpoint so cookies, CSRF and token issuance are
  // exercised exactly as a browser would.
  const login = await ctx.client.post('/api/v1/customer/auth/login', {
    email,
    password: overrides.password ?? CUSTOMER_PASSWORD,
  });

  return {
    user,
    login,
    accessToken: login.json?.data?.access_token,
    csrfToken: login.json?.data?.csrf_token,
    authHeaders: {
      Authorization: `Bearer ${login.json?.data?.access_token ?? ''}`,
      'X-CSRF-Token': login.json?.data?.csrf_token ?? '',
    },
  };
}

/** Password used by the customer fixtures. Policy-compliant, obviously synthetic. */
export const CUSTOMER_PASSWORD = 'Cust0mer!Demo#2026x';

