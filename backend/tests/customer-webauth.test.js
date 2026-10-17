/**
 * FORM-COMPATIBLE customer auth — the contract used by the reference product's
 * own login and registration pages (stakeclone.com, recreated as a guide and
 * NOT copied):
 * login and registration pages:
 *
 *   POST /login    application/x-www-form-urlencoded  _token, email, password, remember
 *   POST /register application/x-www-form-urlencoded  _token, name, username, email,
 *                                                    password, password_confirmation, privacy
 *
 * These are REDIRECT flows, not JSON: success is a 303 to /account with a
 * session cookie, failure is a 303 back with ?error=<code>. The tests prove
 * the whole loop — CSRF issue/verify, register, sign-in, the shared identity
 * with the JSON API, lockout, and that every validation path redirects with
 * the right code.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestContext, CUSTOMER_PASSWORD } from './helpers/context.js';

let ctx;
let csrfCookie = '';

function getCookie(name) {
  return ctx.client.cookies.get(name)?.value ?? '';
}

/** Reads a 303's Location header WITHOUT following it. */
async function formPost(path, fields) {
  const body = new URLSearchParams(fields).toString();
  const res = await fetch(`${ctx.baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Cookie: [...ctx.client.cookies.entries()]
        .map(([k, v]) => `${k}=${v.value}`).join('; '),
    },
    body,
    redirect: 'manual',
  });
  // Keep the jar in sync with any Set-Cookie the form flow issued.
  for (const raw of res.headers.getSetCookie?.() ?? []) {
    const [pair] = raw.split(';').map((s) => s.trim());
    const eq = pair.indexOf('=');
    if (eq > 0) ctx.client.cookies.set(pair.slice(0, eq), { value: pair.slice(eq + 1) });
  }
  const text = await res.text();
  return { status: res.status, location: res.headers.get('location') ?? '', text };
}

async function getPage(path) {
  const res = await ctx.client.get(path);
  // /login and /register set a fresh csrf cookie; remember it for the next POST.
  const csrf = getCookie('csrf_token');
  if (csrf) csrfCookie = csrf;
  return res;
}

before(async () => {
  ctx = await createTestContext();
});

after(async () => {
  await ctx.close();
});

// ---------------------------------------------------------------------------
test('GET /login serves the form and issues a CSRF cookie + _token field', async () => {
  const res = await getPage('/login');
  assert.equal(res.status, 200);
  assert.match(res.text, /name="_token"/);
  assert.match(res.text, /name="email"/);
  assert.match(res.text, /name="password"/);
  assert.match(res.text, /name="remember"/);
  assert.ok(csrfCookie.length >= 16, 'a csrf_token cookie was issued');
  assert.match(res.text, new RegExp(`value="${csrfCookie}"`), 'the _token field matches the cookie');
});

test('POST /login without a valid _token is bounced with ?error=csrf', async () => {
  await getPage('/login');
  const res = await formPost('/login', {
    _token: 'not-the-real-token-value-x',
    email: 'anyone@example.com',
    password: 'Whatever!Password1',
  });
  assert.equal(res.status, 303);
  assert.match(res.location, /\/login\?error=csrf/);
});

test('POST /login with unknown credentials redirects with ?error=credentials', async () => {
  await getPage('/login');
  const res = await formPost('/login', {
    _token: csrfCookie,
    email: 'ghost@example.com',
    password: 'Whatever!Password1',
  });
  assert.equal(res.status, 303);
  assert.match(res.location, /\/login\?error=credentials/);
});

test('a provisioned customer can sign in via the form and reach /account', async () => {
  // Provision a real customer through the same path production uses.
  const { randomUUID } = await import('node:crypto');
  const bcrypt = (await import('bcryptjs')).default;
  const { userRepo, customerAuthRepo } = ctx.db.repositories;
  const email = `web-${Date.now()}@example.com`;
  const user = await userRepo.create({
    id: randomUUID(), fullName: 'Web Customer', email, username: `webcust${Date.now()}`,
    balanceMinor: 45000, status: 'active', kycStatus: 'verified', isDemo: 1,
  });
  await customerAuthRepo.create({
    userId: user.id, passwordHash: await bcrypt.hash(CUSTOMER_PASSWORD, 4),
  });

  await getPage('/login');
  const login = await formPost('/login', {
    _token: csrfCookie, email, password: CUSTOMER_PASSWORD, remember: '1',
  });
  assert.equal(login.status, 303, login.text.slice(0, 200));
  assert.match(login.location, /^\/account/);
  assert.ok(getCookie('web_session'), 'the web_session cookie was set');

  const account = await ctx.client.get('/account');
  assert.equal(account.status, 200);
  assert.match(account.text, /Web Customer/);
  assert.match(account.text, new RegExp(user.public_ref), 'shows the same users row');
  assert.match(account.text, /450.00/);
});

test('the FORM session and the JSON API share one identity', async () => {
  // web_session is a signed customer token, so the JSON endpoints accept it
  // through the same authenticateCustomer middleware — one source of truth.
  const res = await ctx.client.get('/api/v1/customer/dashboard/summary');
  assert.equal(res.status, 200);
  const d = res.json?.data ?? {};
  assert.equal(d.balance?.read_only, true);
  assert.ok(Array.isArray(d.unavailable));
});

test('register validates every field and redirects with the right error code', async () => {
  const cases = [
    [{ _token: 'short', name: 'A B', username: 'okname', email: 'a@example.com', password: CUSTOMER_PASSWORD, password_confirmation: CUSTOMER_PASSWORD, privacy: '1' }, 'csrf'],
    // name too short
    [{ name: 'A', username: 'okname1', email: 'a1@example.com', password: CUSTOMER_PASSWORD, password_confirmation: CUSTOMER_PASSWORD, privacy: '1' }, 'validation'],
    // bad username
    [{ name: 'Good Name', username: 'NO!', email: 'a2@example.com', password: CUSTOMER_PASSWORD, password_confirmation: CUSTOMER_PASSWORD, privacy: '1' }, 'validation'],
    // password mismatch
    [{ name: 'Good Name', username: 'okname2', email: 'a3@example.com', password: CUSTOMER_PASSWORD, password_confirmation: 'different', privacy: '1' }, 'validation'],
    // weak password
    [{ name: 'Good Name', username: 'okname3', email: 'a4@example.com', password: 'weak', password_confirmation: 'weak', privacy: '1' }, 'validation'],
    // terms not accepted
    [{ name: 'Good Name', username: 'okname4', email: 'a5@example.com', password: CUSTOMER_PASSWORD, password_confirmation: CUSTOMER_PASSWORD }, 'terms'],
  ];
  for (const [raw, expected] of cases) {
    await getPage('/register');
    // Every case needs the CURRENT valid token except the one deliberately
    // testing CSRF rejection (which carries its own bogus value).
    const fields = { _token: csrfCookie, ...raw };
    const res = await formPost('/register', fields);
    assert.equal(res.status, 303, JSON.stringify(fields));
    assert.match(res.location, new RegExp(`error=${expected}`), JSON.stringify(fields));
  }
});

test('registration creates the customer, signs them in, and honours uniqueness', async () => {
  const stamp = Date.now();
  const fields = {
    name: 'Fresh Customer',
    username: `fresh${stamp}`,
    email: `fresh-${stamp}@example.com`,
    password: CUSTOMER_PASSWORD,
    password_confirmation: CUSTOMER_PASSWORD,
    privacy: '1',
  };

  await getPage('/register');
  const reg = await formPost('/register', { _token: csrfCookie, ...fields });
  assert.equal(reg.status, 303, reg.text.slice(0, 200));
  assert.match(reg.location, /^\/account/);
  assert.ok(getCookie('web_session'), 'auto signed in');

  const account = await ctx.client.get('/account');
  assert.equal(account.status, 200);
  assert.match(account.text, /Fresh Customer/);
  assert.match(account.text, new RegExp(`fresh${stamp}`), 'username is stored');

  // Duplicate email -> ?error=email
  ctx.client.cookies.delete('web_session');
  await getPage('/register');
  const dupEmail = await formPost('/register', {
    _token: csrfCookie,
    name: 'Other Person', username: `other${stamp}`, email: fields.email,
    password: CUSTOMER_PASSWORD, password_confirmation: CUSTOMER_PASSWORD, privacy: '1',
  });
  assert.equal(dupEmail.status, 303);
  assert.match(dupEmail.location, /error=email/);

  // Duplicate username -> ?error=username
  await getPage('/register');
  const dupUser = await formPost('/register', {
    _token: csrfCookie,
    name: 'Other Person', username: fields.username, email: `alt-${stamp}@example.com`,
    password: CUSTOMER_PASSWORD, password_confirmation: CUSTOMER_PASSWORD, privacy: '1',
  });
  assert.equal(dupUser.status, 303);
  assert.match(dupUser.location, /error=username/);
});

test('signing out clears the session and protects /account', async () => {
  const stamp = Date.now();
  await getPage('/register');
  const reg = await formPost('/register', {
    _token: csrfCookie,
    name: 'Logout Test', username: `logout${stamp}`, email: `logout-${stamp}@example.com`,
    password: CUSTOMER_PASSWORD, password_confirmation: CUSTOMER_PASSWORD, privacy: '1',
  });
  assert.equal(reg.status, 303);
  assert.ok(getCookie('web_session'));

  const out = await formPost('/logout', { _token: csrfCookie });
  assert.equal(out.status, 303);
  assert.match(out.location, /\/login/);

  const account = await ctx.client.get('/account');
  assert.equal(account.status, 401, '/account is protected without a session');
});

test('repeated failures through the FORM lock the account, like the API does', async () => {
  const { randomUUID } = await import('node:crypto');
  const bcrypt = (await import('bcryptjs')).default;
  const { userRepo, customerAuthRepo } = ctx.db.repositories;
  const email = `locked-${Date.now()}@example.com`;
  const user = await userRepo.create({
    id: randomUUID(), fullName: 'Locked Customer', email, username: `lock${Date.now()}`,
    status: 'active', kycStatus: 'pending', isDemo: 1,
  });
  await customerAuthRepo.create({ userId: user.id, passwordHash: await bcrypt.hash(CUSTOMER_PASSWORD, 4) });

  let last = null;
  for (let i = 0; i < 8; i += 1) {
    await getPage('/login');
    last = await formPost('/login', {
      _token: csrfCookie, email, password: 'definitely-wrong-password',
    });
  }
  assert.equal(last.status, 303);
  assert.match(last.location, /error=locked/);

  // Even the CORRECT password is refused while locked.
  await getPage('/login');
  const retry = await formPost('/login', { _token: csrfCookie, email, password: CUSTOMER_PASSWORD });
  assert.match(retry.location, /error=locked/);
});
