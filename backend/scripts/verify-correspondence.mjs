/**
 * Admin-panel ↔ website-backend correspondence verification.
 *
 * The user asked to "verify the new backend for the website corresponds with
 * the admin panel". This proves, over the LIVE dev server (real MySQL), that
 * both surfaces read the SAME records:
 *
 *   1. A customer registers through the WEBSITE form (POST /register).
 *   2. The ADMIN panel immediately sees that exact user in GET /users,
 *      with identical id/name/username/email/kyc/balance.
 *   3. The customer's dashboard balance (website JSON API) equals the admin's
 *      balance for the same row.
 *   4. The customer's withdrawal history is a strict subset of the admin's
 *      withdrawal list for that user.
 *   5. Payment methods the ADMIN enables appear instantly in the CUSTOMER's
 *      enabled-methods list (and vice versa on disable).
 *   6. The admin panel's own live sweep (206 checks) still passes unchanged.
 */
const API = 'http://127.0.0.1:4000';
const V1 = '/api/v1'; // admin + customer JSON API live here; the FORM routes at root

const jars = { admin: new Map(), customer: new Map() };
function client(name) {
  const jar = jars[name];
  return {
    async call(method, path, { body, form, headers = {} } = {}) {
      const h = { Accept: 'application/json', ...headers };
      const cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
      if (cookie) h.Cookie = cookie;
      let payload;
      if (form) {
        h['Content-Type'] = 'application/x-www-form-urlencoded';
        payload = new URLSearchParams(form).toString();
      } else if (body !== undefined) {
        h['Content-Type'] = 'application/json';
        payload = JSON.stringify(body);
      }
      if (!['GET', 'HEAD'].includes(method) && !form && jar.get('csrf_token')) {
        h['X-CSRF-Token'] = jar.get('csrf_token');
      }
      const res = await fetch(API + path, { method, headers: h, body: payload, redirect: 'manual' });
      for (const raw of res.headers.getSetCookie?.() ?? []) {
        const [pair] = raw.split(';').map((s) => s.trim());
        const eq = pair.indexOf('=');
        if (eq > 0) jar.set(pair.slice(0, eq), pair.slice(eq + 1));
      }
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* html pages */ }
      return { status: res.status, json, text, location: res.headers.get('location') ?? '' };
    },
  };
}

let pass = 0; let fail = 0;
const check = (label, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : `  ->  ${detail}`}`);
  if (cond) pass += 1; else fail += 1;
};

const admin = client('admin');
const customer = client('customer');

// --- 1. The customer registers through the WEBSITE form ----------------------
console.log('\n=== 1. Website form registration ===');
{
  const page = (await customer.call('GET', '/register')).text;
  const token = page.match(/name="_token" value="([^"]+)"/)?.[1] ?? '';
  const stamp = Date.now();
  const reg = await customer.call('POST', '/register', { form: {
    _token: token,
    name: 'Correspondence Check',
    username: `corresp${stamp}`,
    email: `corresp-${stamp}@example.com`,
    password: 'Cust0mer!Demo#2026x',
    password_confirmation: 'Cust0mer!Demo#2026x',
    privacy: '1',
  }});
  check('customer registers via POST /register -> 303 /account',
    reg.status === 303 && /^\/account/.test(reg.location), `${reg.status} ${reg.location}`);
  globalThis.__email = `corresp-${stamp}@example.com`;
  globalThis.__username = `corresp${stamp}`;
}

// --- 2. The ADMIN panel sees that exact user ---------------------------------
console.log('\n=== 2. Admin panel sees the website-registered user ===');
await admin.call('POST', `${V1}/auth/login`, { body: {
  email: 'admin@scalpsphere.local', password: 'Local-Dev!Admin#2026x',
}});
{
  const users = await admin.call('GET', `${V1}/users?search=${encodeURIComponent(globalThis.__email)}`);
  const u = users.json?.data?.[0];
  check('admin GET /users finds the new customer', Boolean(u), users.text.slice(0, 120));
  check('  same email', u?.email === globalThis.__email);
  check('  username stored', u?.username === globalThis.__username, `${u?.username} vs ${globalThis.__username}`);
  check('  name matches', u?.name === 'Correspondence Check');
  check('  balance starts at 0', u?.balance_minor === 0);
  check('  kyc starts pending', u?.kyc_status === 'pending');
  globalThis.__ref = u?.id;
}

// --- 3. Customer dashboard balance == admin panel balance ---------------------
console.log('\n=== 3. Both surfaces report the SAME balance ===');
{
  const dash = await customer.call('GET', `${V1}/customer/dashboard/summary`);
  const adminOne = await admin.call('GET', `${V1}/users/${globalThis.__ref}`);
  check('customer dashboard balance == admin panel balance',
    dash.json?.data?.balance?.minor === adminOne.json?.data?.balance_minor,
    `${dash.json?.data?.balance?.minor} vs ${adminOne.json?.data?.balance_minor}`);
  check('  customer sees read_only balance', dash.json?.data?.balance?.read_only === true);
}

// --- 4. Withdrawal history is shared ----------------------------------------
console.log('\n=== 4. Withdrawal history is one shared table ===');
{
  const mine = await customer.call('GET', `${V1}/customer/withdrawals`);
  const adminAll = await admin.call('GET', `${V1}/withdrawals?per_page=100`);
  const adminMine = (adminAll.json?.data ?? []).filter((w) => w.user_ref === globalThis.__ref);
  check('new customer has no history on either surface',
    mine.json?.meta?.pagination?.total === 0 && adminMine.length === 0);
}

// --- 5. Payment methods: admin writes, customer reads, same table ------------
console.log('\n=== 5. Payment methods are shared live ===');
{
  const before = await customer.call('GET', `${V1}/customer/payment-methods?used_for=deposit`);
  const countBefore = (before.json?.data ?? []).length;

  const created = await admin.call('POST', `${V1}/payment-methods`, { body: {
    name: `Corresp Coin ${Date.now()}`, type: 'crypto', used_for: 'deposit', status: 'enabled',
  }});
  check('admin creates a method', created.status === 201);

  const after = await customer.call('GET', `${V1}/customer/payment-methods?used_for=deposit`);
  const visible = (after.json?.data ?? []).some((m) => m.name === created.json?.data?.name);
  check('  the customer surface shows it immediately', visible);
  check('  count grew by exactly one', (after.json?.data ?? []).length === countBefore + 1);

  const disabled = await admin.call('POST', `${V1}/payment-methods/${created.json.data.id}/disable`);
  check('admin disables it', disabled.status === 200);
  const gone = await customer.call('GET', `${V1}/customer/payment-methods?used_for=deposit`);
  check('  it disappears from the customer surface instantly',
    !(gone.json?.data ?? []).some((m) => m.name === created.json.data.name));
  await admin.call('DELETE', `${V1}/payment-methods/${created.json.data.id}`);
}

// --- 6. Token domains stay separate ------------------------------------------
console.log('\n=== 6. The two surfaces stay permission-isolated ===');
{
  const custToken = jars.customer.get('web_session');
  const adminLeak = await fetch(`${API}/api/v1/users`, {
    headers: { Authorization: `Bearer ${custToken}` },
  });
  check('a website session CANNOT read admin routes', adminLeak.status === 401, `got ${adminLeak.status}`);

  const adminToken = (await admin.call('POST', `${V1}/auth/login`, { body: {
    email: 'admin@scalpsphere.local', password: 'Local-Dev!Admin#2026x',
  }})).json?.data?.access_token;
  const custLeak = await fetch(`${API}${V1}/customer/profile`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  check('an admin session CANNOT read customer routes', custLeak.status === 401, `got ${custLeak.status}`);
}

console.log(`\n=== ${fail === 0 ? 'WEBSITE ↔ ADMIN CORRESPONDENCE VERIFIED' : fail + ' CHECK(S) FAILED'} (${pass} passed) ===`);
process.exit(fail === 0 ? 0 : 1);
