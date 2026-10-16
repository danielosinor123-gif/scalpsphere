#!/usr/bin/env node
/**
 * End-to-end smoke test against a real MySQL / MariaDB database.
 *
 * Exercises the complete operational path, not just the HTTP contract:
 *
 *   1. scripts/seed-demo.js  --reset --yes   (demo fixtures)
 *   2. scripts/create-admin.js              (out-of-band provisioning)
 *   3. the real HTTP API: login, dashboard, users, withdrawals,
 *      payment-method CRUD, settings, audit log, auth failures
 *
 * Usage (point DB_* at a THROWAWAY schema — this command wipes it):
 *
 *   DB_DRIVER=mysql DB_NAME=scalpsphere_test \
 *   DB_USER=... DB_PASSWORD=... JWT_ACCESS_SECRET=... \
 *   npm run smoke:db
 *
 * Exits non-zero if any check fails. Requires `npm run migrate` to have been
 * run against the same schema first.
 */
const HERE = new URL('.', import.meta.url);

const { execFileSync } = await import('node:child_process');
const { fileURLToPath } = await import('node:url');

const BACKEND_ROOT = fileURLToPath(new URL('../', import.meta.url));

// ---------------------------------------------------------------------------
// SAFETY GUARD — must run BEFORE anything destructive.
//
// This script wipes the target schema (seed --reset truncates every application
// table, and create-admin writes to it). Refuse to run against any schema whose
// name does not contain "test", so a `.env` pointing at the development or
// production database cannot be silently destroyed.
// ---------------------------------------------------------------------------
{
  const { env } = await import('../src/config/env.js');
  const name = String(env.db.database ?? '').toLowerCase();
  if (!name.includes('test')) {
    process.stderr.write(
      `\nREFUSING TO RUN\n` +
        `This smoke test wipes the target schema, and DB_NAME is "${name}".\n` +
        `Point it at a throwaway database whose name contains "test", e.g.\n` +
        `  DB_NAME=scalpsphere_test npm run smoke:db\n`,
    );
    process.exit(2);
  }
}

function runScript(name, args = [], extraEnv = {}) {
  const script = fileURLToPath(new URL(`./${name}`, HERE));
  const env = { ...process.env, ...extraEnv };
  try {
    const out = execFileSync(process.execPath, [script, ...args], {
      cwd: BACKEND_ROOT,
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, out };
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { status: -1, out: `[smoke] could not spawn ${script}: ${err.message}\n` };
    }
    return { status: err.status ?? -1, out: String(err.stdout ?? '') + String(err.stderr ?? '') };
  }
}

let failures = 0;
function check(label, cond, detail = '') {
  process.stdout.write(`${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : `  ${detail}`}\n`);
  if (!cond) failures += 1;
}

const ADMIN_EMAIL = `smoke-owner-${Date.now()}@example.com`;
const ADMIN_PASSWORD = 'Sm0ke!Str0ng#Passw0rd';

// ---------------------------------------------------------------------------
// 1. Reset and seed demo fixtures
// ---------------------------------------------------------------------------
process.stdout.write('\n=== 1. seed --reset --yes ===\n');
const seed = runScript('seed-demo.js', ['--reset', '--yes']);
process.stdout.write(seed.out);
check('seed succeeded', seed.status === 0, seed.out);

// ---------------------------------------------------------------------------
// 2. Provision the administrator out of band (the only way one can exist).
//    The password is passed through the child environment, which is the
//    documented non-interactive path; it is never written to disk.
// ---------------------------------------------------------------------------
process.stdout.write('\n=== 2. admin:create ===\n');
const created = runScript(
  'create-admin.js',
  ['--email', ADMIN_EMAIL, '--name', 'Smoke Owner', '--role', 'owner'],
  { ADMIN_PASSWORD },
);
process.stdout.write(created.out);
check('admin created', created.status === 0, created.out);

// ---------------------------------------------------------------------------
// 3. Boot the real app and drive it over HTTP
// ---------------------------------------------------------------------------
const { createDatabase } = await import('../src/db/index.js');
const { createApp } = await import('../src/app.js');

const db = await createDatabase();

// Hard guard: this script DELETES every application table. Refuse to run it
// against anything that does not look like a throwaway test schema.
{
  const { env } = await import('../src/config/env.js');
  const name = String(env.db.database ?? '').toLowerCase();
  if (!name.includes('test')) {
    process.stderr.write(
      `\nREFUSING TO RUN\n` +
        `The smoke test wipes the target schema, and DB_NAME is "${name}".\n` +
        `Point it at a throwaway database whose name contains "test", e.g.\n` +
        `  DB_NAME=scalpsphere_test npm run smoke:db\n`,
    );
    process.exit(2);
  }
}

const app = createApp({ db });
const server = app.listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;

const jar = new Map();
function collect(res) {
  for (const raw of res.headers.getSetCookie?.() ?? []) {
    const [pair] = raw.split(';').map((s) => s.trim());
    const eq = pair.indexOf('=');
    jar.set(pair.slice(0, eq), pair.slice(eq + 1));
  }
}
const cookies = () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');

async function call(method, path, body, extraHeaders = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', Cookie: cookies(), ...extraHeaders },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  });
  collect(res);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 204 has no body */ }
  return { status: res.status, json, text };
}

try {
  // --- login -------------------------------------------------------------
  process.stdout.write('\n=== 3. login ===\n');
  const login = await call('POST', '/api/v1/auth/login', {
    email: ADMIN_EMAIL,
    password: ADMIN_PASSWORD,
  });
  const csrf = login.json?.data?.csrf_token;
  check('login returns 200', login.status === 200, login.text.slice(0, 300));
  const auth = { Authorization: `Bearer ${login.json?.data?.access_token}`, 'X-CSRF-Token': csrf };

  // --- dashboard ---------------------------------------------------------
  process.stdout.write('\n=== 4. dashboard ===\n');
  const summary = await call('GET', '/api/v1/dashboard/summary');
  check('dashboard summary 200', summary.status === 200, summary.text.slice(0, 300));
  const cards = summary.json?.data?.cards ?? {};
  check('four cards present', Object.keys(cards).length === 4, Object.keys(cards).join(','));
  check(
    'total_users matches seeded fixtures',
    cards.total_users?.value === 5,
    `got ${cards.total_users?.value}`,
  );
  check(
    'total_users display has no currency symbol',
    cards.total_users?.display_value === '5',
    `got ${cards.total_users?.display_value}`,
  );
  check('total_users computed live', cards.total_users?.is_demo === false);
  check('total_deposits flagged as demo', cards.total_deposits?.is_demo === true);
  check(
    'pending_withdrawals computed live',
    cards.pending_withdrawals?.count === 1,
    `got ${cards.pending_withdrawals?.count}`,
  );
  check(
    'activity has 7 points',
    summary.json?.data?.activity?.points?.length === 7,
    `got ${summary.json?.data?.activity?.points?.length}`,
  );

  const users = await call('GET', '/api/v1/users?per_page=100');
  check(
    'users pagination total is 5',
    users.json?.meta?.pagination?.total === 5,
    `got ${users.json?.meta?.pagination?.total}`,
  );
  check(
    'user ids are USR- references',
    /^USR-\d{5}$/.test(users.json?.data?.[0]?.id ?? ''),
    String(users.json?.data?.[0]?.id),
  );
  check(
    'balance_display is a formatted string',
    /^\$[\d,]+\.\d{2}$/.test(users.json?.data?.[0]?.balance_display ?? ''),
    String(users.json?.data?.[0]?.balance_display),
  );

  const wds = await call('GET', '/api/v1/withdrawals?per_page=100');
  check(
    'withdrawals pagination total is 3',
    wds.json?.meta?.pagination?.total === 3,
    `got ${wds.json?.meta?.pagination?.total}`,
  );
  check(
    'withdrawal ids are WDR- references',
    /^WDR-\d{5}$/.test(wds.json?.data?.[0]?.id ?? ''),
    String(wds.json?.data?.[0]?.id),
  );

  // --- payment methods ---------------------------------------------------
  process.stdout.write('\n=== 5. payment methods ===\n');
  const methods = await call('GET', '/api/v1/payment-methods?per_page=100');
  check(
    'seeded methods total is 21',
    methods.json?.meta?.pagination?.total === 21,
    `got ${methods.json?.meta?.pagination?.total}`,
  );
  check(
    'method ids are PAY- references',
    /^PAY-\d{5}$/.test(methods.json?.data?.[0]?.id ?? ''),
    String(methods.json?.data?.[0]?.id),
  );
  check(
    'the duplicated "Litecoin" demo row is seeded exactly once',
    methods.json?.data?.filter((m) => m.name === 'Litecoin').length === 1,
  );

  const createMethod = await call(
    'POST',
    '/api/v1/payment-methods',
    { name: 'Smoke Coin', type: 'crypto', used_for: 'both' },
    auth,
  );
  check('create returns 201', createMethod.status === 201, createMethod.text.slice(0, 300));
  const methodId = createMethod.json?.data?.id;
  check('created id is a PAY reference', /^PAY-\d{5}$/.test(methodId ?? ''), String(methodId));

  const patchMethod = await call(
    'PATCH',
    `/api/v1/payment-methods/${methodId}`,
    { name: 'Smoke Coin Renamed', status: 'enabled' },
    auth,
  );
  check('update returns 200', patchMethod.status === 200, patchMethod.text.slice(0, 300));

  const disable = await call('POST', `/api/v1/payment-methods/${methodId}/disable`, {}, auth);
  check(
    'disable returns 200 and status is disabled',
    disable.status === 200 && disable.json?.data?.status === 'disabled',
  );

  // Case-insensitive duplicate against the collation.
  const dup = await call(
    'POST',
    '/api/v1/payment-methods',
    { name: 'smoke coin renamed', type: 'crypto', used_for: 'both' },
    auth,
  );
  check('duplicate name returns 409', dup.status === 409, `got ${dup.status}`);

  const del = await call('DELETE', `/api/v1/payment-methods/${methodId}`, undefined, auth);
  check('delete returns 204', del.status === 204, `got ${del.status}`);

  // --- settings -----------------------------------------------------------
  process.stdout.write('\n=== 6. settings ===\n');
  const put = await call(
    'PUT',
    '/api/v1/payment-settings',
    {
      default_currency: 'NGN',
      processing_mode: 'manual_review',
      payment_instructions: 'Smoke instructions — replace before going live.',
      minimum_deposit: '250.50',
      minimum_withdrawal: 1000,
    },
    auth,
  );
  check('PUT settings returns 200', put.status === 200, put.text.slice(0, 300));
  check(
    'minimum_deposit rendered in the selected currency',
    put.json?.data?.minimum_deposit_display === '₦250.50',
    String(put.json?.data?.minimum_deposit_display),
  );

  const summary2 = await call('GET', '/api/v1/dashboard/summary');
  check('selected currency flows to the dashboard', summary2.json?.data?.currency === 'NGN');
  check(
    'deposit card rendered in the selected currency',
    summary2.json?.data?.cards?.total_deposits?.display_value?.startsWith('₦'),
    String(summary2.json?.data?.cards?.total_deposits?.display_value),
  );

  // --- audit log ----------------------------------------------------------
  process.stdout.write('\n=== 7. audit log ===\n');
  const audit = await call('GET', '/api/v1/audit-log?per_page=100');
  check('audit entries exist', (audit.json?.meta?.pagination?.total ?? 0) > 0);
  const actions = new Set((audit.json?.data ?? []).map((e) => e.action));
  check('login is audited', actions.has('auth.login_succeeded'));
  check('payment-method create is audited', actions.has('payment_method.created'));
  check('settings update is audited', actions.has('payment_settings.updated'));
  const auditText = JSON.stringify(audit.json);
  check(
    'no credential VALUES appear in the audit log',
    // Not the words "password"/"token" — those legitimately occur in action
    // names like auth.password_changed. What must never appear is a real value.
    !/\$2[aby]\$[0-9a-zA-Z./]{53}/.test(auditText) &&
      !auditText.includes(ADMIN_PASSWORD) &&
      !auditText.includes(login.json?.data?.access_token ?? '<<none>>') &&
      !auditText.includes(login.json?.data?.csrf_token ?? '<<none>>'),
  );

  // --- auth edge cases ----------------------------------------------------
  process.stdout.write('\n=== 8. auth edge cases ===\n');
  const badLogin = await call('POST', '/api/v1/auth/login', {
    email: ADMIN_EMAIL,
    password: 'definitely-wrong',
  });
  check('wrong password returns 401', badLogin.status === 401, `got ${badLogin.status}`);

  jar.clear();
  const noAuth = await call('GET', '/api/v1/users');
  check('unauthenticated request returns 401', noAuth.status === 401);

  const bearerOnly = await call('GET', '/api/v1/users', undefined, {
    Authorization: 'Bearer not-a-real-token',
  });
  check('tampered bearer token returns 401', bearerOnly.status === 401);
} finally {
  await new Promise((r) => server.close(r));
  await db.close();
}

process.stdout.write(`\n=== ${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`} ===\n`);
process.exit(failures === 0 ? 0 : 1);
