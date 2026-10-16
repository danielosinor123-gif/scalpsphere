/**
 * Verifies the RUNNING dev server at http://127.0.0.1:4000 end to end, using the
 * local admin account. Run after `npm run dev`.
 */
const BASE = 'http://127.0.0.1:4000/api/v1';
const EMAIL = 'admin@scalpsphere.local';
const PASSWORD = 'Local-Dev!Admin#2026x';

const jar = new Map();
function collect(res) {
  for (const raw of res.headers.getSetCookie?.() ?? []) {
    const [pair] = raw.split(';').map((s) => s.trim());
    const eq = pair.indexOf('=');
    jar.set(pair.slice(0, eq), pair.slice(eq + 1));
  }
}
const cookies = () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');

async function call(method, path, body, extra = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', Cookie: cookies(), ...extra },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  });
  collect(res);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 204 */ }
  return { status: res.status, json };
}

let failures = 0;
const check = (label, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : `  ${detail}`}`);
  if (!cond) failures += 1;
};

const health = await call('GET', '/health');
check('GET /health', health.status === 200 && health.json?.data?.status === 'ok',
  JSON.stringify(health.json).slice(0, 200));
check('database driver is mysql', health.json?.data?.checks?.driver === 'mysql');
check('durable', health.json?.data?.checks?.durable === true);

const login = await call('POST', '/auth/login', { email: EMAIL, password: PASSWORD });
check('login', login.status === 200, JSON.stringify(login.json).slice(0, 200));
const auth = { Authorization: `Bearer ${login.json?.data?.access_token}`, 'X-CSRF-Token': login.json?.data?.csrf_token };

const summary = await call('GET', '/dashboard/summary');
const cards = summary.json?.data?.cards ?? {};
check('dashboard summary', summary.status === 200);
check('total_users = 5 (seeded)', cards.total_users?.value === 5, `got ${cards.total_users?.value}`);
check('total_users display "5" (no $)', cards.total_users?.display_value === '5', `got ${cards.total_users?.display_value}`);
check('pending_withdrawals count 1', cards.pending_withdrawals?.count === 1);
check('total_deposits flagged demo', cards.total_deposits?.is_demo === true);

const users = await call('GET', '/users?per_page=100');
check('users total 5', users.json?.meta?.pagination?.total === 5, `got ${users.json?.meta?.pagination?.total}`);
// References are drawn from a monotonic AUTO_INCREMENT sequence and are never
// reused, so after a re-seed they will not restart at 00001. Assert the shape,
// the count and the uniqueness instead of exact numbers.
const refs = (users.json?.data ?? []).map((u) => u.id);
check(
  'all user references match USR-#####',
  refs.length === 5 && refs.every((r) => /^USR-\d{5}$/.test(r)),
  `got ${refs.join(', ')}`,
);
check('user references are unique', new Set(refs).size === refs.length);
const trayson = users.json?.data?.find((u) => u.name === 'Trayson Abraham White');
check('Trayson Abraham White present with $450.00', trayson?.balance_display === '$450.00', JSON.stringify(trayson));

const wds = await call('GET', '/withdrawals?per_page=100');
check('withdrawals total 3', wds.json?.meta?.pagination?.total === 3);
const chanWd = wds.json?.data?.find((w) => w.client_name === 'CHAN LYE KLUAN');
check('CHAN LYE KLUAN withdrawal $537.00 pending',
  chanWd?.amount_display === '$537.00' && chanWd?.status === 'pending', JSON.stringify(chanWd));

const search = await call('GET', '/users?search=wright');
check('search "wright" finds 2 users', search.json?.meta?.pagination?.total === 2,
  `got ${search.json?.meta?.pagination?.total}`);

const methods = await call('GET', '/payment-methods?per_page=100');
check('payment methods total 21', methods.json?.meta?.pagination?.total === 21);
check('Litecoin seeded once', methods.json?.data?.filter((m) => m.name === 'Litecoin').length === 1);
const usdt = methods.json?.data?.find((m) => m.name === 'USDT');
check('USDT enabled', usdt?.status === 'enabled', JSON.stringify(usdt));

const created = await call('POST', '/payment-methods', { name: 'Local Test Coin', type: 'crypto', used_for: 'both' }, auth);
check('create method 201', created.status === 201, JSON.stringify(created.json).slice(0, 200));
await call('DELETE', `/api/v1/payment-methods`.length ? `/payment-methods/${created.json?.data?.id}` : '', undefined, auth);

const settings = await call('GET', '/payment-settings');
check('settings defaults USD / $10.00',
  settings.json?.data?.default_currency === 'USD' && settings.json?.data?.minimum_deposit_display === '$10.00',
  JSON.stringify(settings.json?.data));

const audit = await call('GET', '/audit-log?per_page=100');
check('audit log has entries', (audit.json?.meta?.pagination?.total ?? 0) > 0);
check('login audited', (audit.json?.data ?? []).some((e) => e.action === 'auth.login_succeeded'));

// The invariant is "no credential VALUES", not "no credential words": action
// names like auth.password_changed and summaries like "previous refresh token
// revoked" legitimately contain those words. What must never appear is a hash,
// a real password, or a live token.
const auditText = JSON.stringify(audit.json);
check(
  'no credential VALUES in the audit log',
  !/\$2[aby]\$[0-9a-zA-Z./]{53}/.test(auditText) &&
    !auditText.includes(PASSWORD) &&
    !auditText.includes(String(login.json?.data?.access_token ?? '<<none>>')) &&
    !auditText.includes(String(login.json?.data?.csrf_token ?? '<<none>>')),
);

console.log(`\n=== ${failures === 0 ? 'DEV SERVER VERIFIED' : failures + ' CHECK(S) FAILED'} ===`);
process.exit(failures === 0 ? 0 : 1);
