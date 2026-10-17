/**
 * Live end-to-end check of the FORM-COMPATIBLE flow against the running dev
 * server (real MariaDB, scalpsphere schema) — the exact contract used by
 * the reference product's own login and registration pages (stakeclone.com,
 * recreated as a guide — not copied).
 */
const BASE = 'http://127.0.0.1:4000';
const jar = new Map();

function cookieHeader() {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}
function storeCookies(res) {
  for (const raw of res.headers.getSetCookie?.() ?? []) {
    const [pair] = raw.split(';').map((s) => s.trim());
    const eq = pair.indexOf('=');
    if (eq > 0) jar.set(pair.slice(0, eq), pair.slice(eq + 1));
  }
}
async function get(path) {
  const res = await fetch(BASE + path, { headers: { Cookie: cookieHeader() } });
  storeCookies(res);
  return { status: res.status, text: await res.text() };
}
async function formPost(path, fields) {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookieHeader() },
    body: new URLSearchParams(fields).toString(),
    redirect: 'manual',
  });
  storeCookies(res);
  await res.text();
  return { status: res.status, location: res.headers.get('location') ?? '' };
}

let pass = 0; let fail = 0;
const check = (label, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : `  ->  ${detail}`}`);
  if (cond) pass += 1; else fail += 1;
};

// 1. Login page
const login = await get('/login');
const token = login.text.match(/name="_token" value="([^"]+)"/)?.[1] ?? '';
check('GET /login -> 200, form with _token', login.status === 200 && token.length >= 16);
check('  csrf_token cookie issued', Boolean(jar.get('csrf_token')));

// 2. Bad CSRF
const badCsrf = await formPost('/login', { _token: 'bogus-token-123456', email: 'x@example.com', password: 'Whatever!Password1' });
check('POST /login bad _token -> 303 ?error=csrf', badCsrf.status === 303 && /error=csrf/.test(badCsrf.location));

// 3. Unknown credentials
const page = await get('/login');
const tok2 = page.text.match(/name="_token" value="([^"]+)"/)?.[1] ?? '';
const badCreds = await formPost('/login', { _token: tok2, email: 'ghost@example.com', password: 'Whatever!Password1' });
check('POST /login unknown credentials -> 303 ?error=credentials', badCreds.status === 303 && /error=credentials/.test(badCreds.location));

// 4. Register a brand-new customer through the real form
const regPage = await get('/register');
const regTok = regPage.text.match(/name="_token" value="([^"]+)"/)?.[1] ?? '';
const stamp = Date.now();
const reg = await formPost('/register', {
  _token: regTok,
  name: 'Live Form Customer',
  username: `liveform${stamp}`,
  email: `liveform-${stamp}@example.com`,
  password: 'Cust0mer!Demo#2026x',
  password_confirmation: 'Cust0mer!Demo#2026x',
  privacy: '1',
});
check('POST /register (real form) -> 303 /account', reg.status === 303 && /^\/account/.test(reg.location), reg.location);
check('  web_session cookie set', Boolean(jar.get('web_session')));

// 5. Account page
const account = await get('/account');
check('GET /account -> 200, shows the new customer', account.status === 200 && account.text.includes('Live Form Customer'));
check('  username stored and shown', account.text.includes(`liveform${stamp}`));
check('  balance renders as 0.00', account.text.includes('0.00'));

// 6. The same session works against the JSON API — one identity, two surfaces
const api = await get('/api/v1/customer/dashboard/summary');
check('JSON API accepts the web session', api.status === 200 && JSON.parse(api.text).data?.balance?.read_only === true);
check('  balance is 0 (just registered)', String(JSON.parse(api.text).data?.balance?.minor) === '0');

// 7. Sign out via the form
const outTok = account.text.match(/name="_token" value="([^"]+)"/)?.[1] ?? jar.get('csrf_token') ?? '';
const out = await formPost('/logout', { _token: outTok });
check('POST /logout -> 303 /login', out.status === 303 && /\/login/.test(out.location));
const after = await get('/account');
check('  /account now requires sign-in', after.status === 401);

// 8. Sign back in with the credentials we just created
const loginPage2 = await get('/login');
const tok3 = loginPage2.text.match(/name="_token" value="([^"]+)"/)?.[1] ?? '';
const relogin = await formPost('/login', { _token: tok3, email: `liveform-${stamp}@example.com`, password: 'Cust0mer!Demo#2026x', remember: '1' });
check('POST /login with the new credentials -> 303 /account', relogin.status === 303 && /^\/account/.test(relogin.location));

console.log(`\n=== ${fail === 0 ? 'FORM FLOW VERIFIED LIVE' : fail + ' CHECK(S) FAILED'} (${pass} passed) ===`);
process.exit(fail === 0 ? 0 : 1);
