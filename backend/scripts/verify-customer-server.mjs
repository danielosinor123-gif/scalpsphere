#!/usr/bin/env node
/**
 * Live CUSTOMER-portal verification against the running dev server on
 * http://127.0.0.1:4000 (real MySQL, schema `scalpsphere`).
 *
 * Requires two customers provisioned via the CLI, e.g.:
 *   CUSTOMER_PASSWORD=... npm run customer:credentials -- --email trayson.white@example.com
 *   CUSTOMER_PASSWORD=... npm run customer:credentials -- --email chan.kluan@example.com
 *
 * Proves over real HTTP, against the same rows the admin panel reads:
 *   - sign-in / session / profile / PATCH / dashboard / withdrawals / kyc / methods
 *   - token-domain separation in BOTH directions
 *   - ownership isolation (one customer cannot see the other's records)
 *   - customer and admin views agree on the same row
 */
const BASE = 'http://127.0.0.1:4000/api/v1';
const A_EMAIL = 'trayson.white@example.com';
const B_EMAIL = 'chan.kluan@example.com';
const PASSWORD = process.env.CUSTOMER_PASSWORD ?? 'Cust0mer!Live#2026x';

let pass = 0;
let fail = 0;
const failures = [];
const check = (label, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : `  ->  ${detail}`}`);
  if (cond) pass += 1;
  else { fail += 1; failures.push(label); }
};

function makeClient() {
  const jar = new Map();
  return {
    jar,
    async call(method, path, { body, headers = {} } = {}) {
      const h = { 'Content-Type': 'application/json', ...headers };
      const cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
      if (cookie) h.Cookie = cookie;
      const res = await fetch(BASE + path, {
        method: method,
        headers: h,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'manual',
      });
      for (const raw of res.headers.getSetCookie?.() ?? []) {
        const [pair] = raw.split(';').map((s) => s.trim());
        const eq = pair.indexOf('=');
        jar.set(pair.slice(0, eq), pair.slice(eq + 1));
      }
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* 204 */ }
      return { status: res.status, json, text, setCookies: res.headers.getSetCookie?.() ?? [] };
    },
  };
}

const a = makeClient();
const b = makeClient();

// --- sign-in ---------------------------------------------------------------
const aLogin = await a.call('POST', '/customer/auth/login', { body: { email: A_EMAIL, password: PASSWORD } });
check('customer A signs in -> 200', aLogin.status === 200, JSON.stringify(aLogin.json).slice(0, 140));
check('  sets cust_access_token cookie', aLogin.setCookies.some((c) => /^cust_access_token=/.test(c)));
check('  does NOT set the admin cookie', !aLogin.setCookies.some((c) => /^access_token=/.test(c)));
const aAuth = {
  Authorization: `Bearer ${aLogin.json?.data?.access_token}`,
  'X-CSRF-Token': aLogin.json?.data?.csrf_token,
};

const bLogin = await b.call('POST', '/customer/auth/login', { body: { email: B_EMAIL, password: PASSWORD } });
check('customer B signs in -> 200', bLogin.status === 200);
const bAuth = {
  Authorization: `Bearer ${bLogin.json?.data?.access_token}`,
  'X-CSRF-Token': bLogin.json?.data?.csrf_token,
};

// --- token domain separation, both directions ------------------------------
const aOnAdmin = await a.call('GET', '/users', { headers: aAuth });
check('customer token REJECTED on an admin route', aOnAdmin.status === 401, `got ${aOnAdmin.status}`);

const anon = makeClient();
const adminLogin = await anon.call('POST', '/auth/login', {
  body: { email: 'admin@scalpsphere.local', password: 'Local-Dev!Admin#2026x' },
});
const adminOnCustomer = await a.call('GET', '/customer/profile', {
  headers: { Authorization: `Bearer ${adminLogin.json?.data?.access_token}` },
});
check('admin token REJECTED on a customer route', adminOnCustomer.status === 401, `got ${adminOnCustomer.status}`);
const adminAuth = { Authorization: `Bearer ${adminLogin.json?.data?.access_token}` };

// --- session / profile -----------------------------------------------------
const session = await a.call('GET', '/customer/auth/session', { headers: aAuth });
check('GET /customer/auth/session -> 200', session.status === 200);
check('  member_since present', Boolean(session.json?.data?.member_since));

const profile = await a.call('GET', '/customer/profile', { headers: aAuth });
check('GET /customer/profile -> 200', profile.status === 200);
check('  email matches', profile.json?.data?.email === A_EMAIL);

const renamed = await a.call('PATCH', '/customer/profile', {
  body: { full_name: 'Trayson A. White' }, headers: aAuth,
});
check('PATCH /customer/profile (name) -> 200', renamed.status === 200);
const blocked = await a.call('PATCH', '/customer/profile', {
  body: { full_name: 'x', balance_minor: 999999 }, headers: aAuth,
});
check('PATCH with a financial field -> 422', blocked.status === 422, `got ${blocked.status}`);
// restore
await a.call('PATCH', '/customer/profile', { body: { full_name: 'Trayson Abraham White' }, headers: aAuth });

// --- dashboard -------------------------------------------------------------
const dash = await a.call('GET', '/customer/dashboard/summary', { headers: aAuth });
check('GET /customer/dashboard/summary -> 200', dash.status === 200);
check('  balance.read_only true', dash.json?.data?.balance?.read_only === true);
check('  unavailable blocks present', (dash.json?.data?.unavailable ?? []).length >= 5);
check('  no fabricated ROI field', !('roi_percent' in (dash.json?.data ?? {})));

// --- withdrawals + isolation ----------------------------------------------
// The seed gives trayson.white NO withdrawal and CHAN LYE KLUAN exactly one, so
// these two customers cover both shapes: a clean empty history and a real one.
const aWds = await a.call('GET', '/customer/withdrawals', { headers: aAuth });
const bWds = await b.call('GET', '/customer/withdrawals', { headers: bAuth });
check('A (no history) gets a clean empty list', aWds.status === 200 && aWds.json.data.length === 0,
  `got ${aWds.status}/${aWds.json?.data?.length}`);
check('  with valid pagination metadata', aWds.json?.meta?.pagination?.total === 0);
check('B sees exactly their own withdrawal', bWds.status === 200 && bWds.json.data.length === 1);
check('  A list does not contain B\'s record', !JSON.stringify(aWds.json).includes(bWds.json.data[0].id));

const bRef = bWds.json?.data?.[0]?.id;
const cross = await a.call('GET', `/customer/withdrawals/${bRef}`, { headers: aAuth });
check('A cannot read B\'s withdrawal by id -> 404', cross.status === 404, `got ${cross.status}`);
const own = await b.call('GET', `/customer/withdrawals/${bRef}`, { headers: bAuth });
check('B can read their own -> 200', own.status === 200, `got ${own.status}`);
check('  ownership fields present', Boolean(own.json?.data?.user_ref));

// --- kyc / methods ---------------------------------------------------------
const kyc = await a.call('GET', '/customer/kyc', { headers: aAuth });
check('GET /customer/kyc -> 200, documents_on_file false', kyc.status === 200 && kyc.json?.data?.documents_on_file === false);

const methods = await a.call('GET', '/customer/payment-methods?used_for=withdraw', { headers: aAuth });
check('GET /customer/payment-methods -> 200', methods.status === 200);
check('  only enabled + direction-compatible', (methods.json?.data ?? []).every(
  (m) => m.status === 'enabled' && ['withdraw', 'both'].includes(m.used_for)));

// --- customer and admin agree on the same row ------------------------------
const adminUsers = await anon.call('GET', `/users/${session.json?.data?.id}`, { headers: adminAuth });
check('admin view of the same user -> 200', adminUsers.status === 200);
check('  email agrees', adminUsers.json?.data?.email === profile.json?.data?.email);
check('  balance agrees with the customer dashboard',
  adminUsers.json?.data?.balance_minor === dash.json?.data?.balance?.minor);

// --- logout ---------------------------------------------------------------
const out = await a.call('POST', '/customer/auth/logout', { headers: { 'X-CSRF-Token': aAuth['X-CSRF-Token'] } });
check('logout -> 200', out.status === 200);

console.log(`\n=== ${fail === 0 ? 'CUSTOMER PORTAL VERIFIED LIVE' : fail + ' CHECK(S) FAILED'} (${pass} passed) ===`);
if (failures.length) { console.log('Failures:'); failures.forEach((f) => console.log(`  - ${f}`)); process.exit(1); }
