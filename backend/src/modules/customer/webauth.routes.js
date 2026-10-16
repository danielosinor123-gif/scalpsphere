/**
 * FORM-COMPATIBLE customer auth — the "backend for stakeclone.com/login".
 *
 * The live product's login and registration pages are classic HTML forms:
 *   POST /login    form-urlencoded  _token, email, password, remember
 *   POST /register form-urlencoded  _token, name, username, email, password,
 *                                  password_confirmation, privacy (required)
 * They POST to themselves, carry a `_token` CSRF field, and expect a
 * redirect-based session flow — NOT a JSON API.
 *
 * This module speaks exactly that contract while reusing the same repositories
 * and token domain as the JSON customer API (/api/v1/customer/...), so there is
 * ONE source of truth for users and credentials, not two.
 *
 * Routes (mounted at the ROOT, not under /api/v1, to match the live URLs):
 *   GET  /login      login page (sets the CSRF cookie, embeds _token)
 *   POST /login      authenticate -> 302 /account (sets web_session cookie)
 *   GET  /register   registration page
 *   POST /register   create the customer -> 302 /account (signed in)
 *   GET  /account    authenticated landing page
 *   POST /logout     clears the session -> 302 /login
 *
 * Security: same double-submit CSRF as the rest of the app (the readable
 * csrf_token cookie must equal the _token form field, compared in constant
 * time); same bcrypt verification with a dummy-hash fallback so unknown emails
 * cost the same as wrong passwords; rate-limited; account lockout honoured.
 *
 * On failure these endpoints REDIRECT back with an error code in the query
 * string (the form flow has no JSON error surface), using Laravel's 302
 * convention rather than 401/422, which a browser form would render as a raw
 * error page.
 */
import { env } from '../../config/env.js';
import { randomToken, uuid, safeEqualHex } from '../../lib/ids.js';
import { asyncHandler } from '../../lib/http.js';
import { verifyPassword, hashPassword, passwordPolicyErrors } from '../../lib/password.js';
import { signCustomerAccessToken } from '../../lib/tokens.js';
import {
  authenticateCustomer,
  WEB_SESSION_COOKIE,
} from '../../middleware/authenticateCustomer.js';
import { CSRF_COOKIE_NAME } from '../../middleware/csrf.js';
import { csrfCookieOptions } from '../../middleware/authenticate.js';
import bcrypt from 'bcryptjs';

const DUMMY_HASH = bcrypt.hashSync(randomToken(16), 4);

const USERNAME_RE = /^[a-z0-9_.-]{3,60}$/;
const EMAIL_RE = /^[^\s@,;:"'()[\]\\]+@[^\s@.,;:"'()[\]\\]+(\.[^\s@.,;:"'()[\]\\]+)+$/;

function accessTtlSeconds() {
  const m = /^(\d+)([smhd])$/.exec(String(env.auth.accessTtl).trim());
  if (!m) return 900;
  return Number(m[1]) * ({ s: 1, m: 60, h: 3600, d: 86400 }[m[2]] ?? 60);
}

// ---------------------------------------------------------------------------
// Pages. Deliberately minimal, self-authored markup in ScalpSphere branding —
// NOT the commercial template's markup, which is third-party copyrighted work
// and must not be committed to this repository. The FORM CONTRACT is what
// matters: same fields, same POST target, same redirect flow. To use the
// purchased theme's visuals, drop its files into a static folder and keep
// these field names.
// ---------------------------------------------------------------------------
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&', '<': '<', '>': '>', '"': '"', "'": '&#39;',
  }[c]));
}

function page({ title, body }) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${esc(title)} — ScalpSphere</title>
<style>
:root{--bg:#070b0a;--panel:#0d1411;--line:#1b2a21;--line2:#26372a;--accent:#83ff53;--text:#f3f7f2;--muted:#94a49a;--dim:#637168;--red:#ff646b}
*{box-sizing:border-box}body{margin:0;background:radial-gradient(ellipse at 50% -10%,#10231a 0,transparent 42%),var(--bg);color:var(--text);font:14px/1.55 Inter,ui-sans-serif,system-ui,sans-serif;min-height:100vh;display:grid;place-items:center;padding:24px}
.card{width:min(420px,100%);background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:32px 28px;box-shadow:0 8px 30px rgba(0,0,0,.45)}
h1{margin:0 0 6px;font-size:20px;letter-spacing:-.04em}
.brand{display:flex;align-items:center;gap:10px;margin-bottom:18px;font-weight:800}
.mark{width:32px;height:32px;border-radius:10px;background:linear-gradient(145deg,#b5ff83,#45d82e);display:grid;place-items:center;color:#071007;font-weight:1000}
.sub{color:var(--muted);font-size:12.5px;margin:0 0 20px}
label{display:block;font-size:12px;font-weight:700;color:var(--muted);margin:0 0 6px}
input[type=text],input[type=email],input[type=password]{width:100%;background:#0a100d;border:1px solid var(--line2);border-radius:8px;color:var(--text);padding:10px 11px;font:inherit;margin-bottom:14px}
input:focus{border-color:var(--accent);outline:none;box-shadow:0 0 0 3px rgba(131,255,83,.15)}
.chk{display:flex;align-items:center;gap:8px;margin:0 0 16px;font-size:12.5px;color:var(--muted)}
.chk input{margin:0}
button{width:100%;border:1px solid transparent;border-radius:8px;padding:11px;font:inherit;font-weight:750;cursor:pointer;background:linear-gradient(145deg,#b5ff83,#45d82e);color:#071006}
button:hover{background:linear-gradient(145deg,#c2ff98,#52e638)}
.err{margin:0 0 14px;padding:10px 12px;background:rgba(255,100,107,.12);border:1px solid rgba(255,100,107,.3);color:var(--red);border-radius:8px;font-size:12.5px}
.ok{margin:0 0 14px;padding:10px 12px;background:rgba(131,255,83,.12);border:1px solid rgba(131,255,83,.3);color:var(--accent);border-radius:8px;font-size:12.5px}
.fine{margin-top:18px;color:var(--dim);font-size:11.5px;text-align:center}
a{color:var(--accent)}
dt{color:var(--dim);font-size:12px}dd{margin:0 0 10px;overflow-wrap:anywhere}
.dl{display:grid;grid-template-columns:130px 1fr;gap:6px 14px;font-size:13px;margin:0 0 18px}
.kv{background:#101a15;border:1px solid var(--line);border-radius:10px;padding:12px 14px;margin-bottom:10px}
.kv b{display:block;font-size:20px;margin-top:3px}
nav.top{display:flex;justify-content:space-between;align-items:center;margin-bottom:18px}
form.inline{display:inline}
button.ghost{width:auto;background:none;border:1px solid var(--line2);color:var(--muted);padding:7px 12px;font-size:12px}
button.ghost:hover{border-color:var(--accent);color:var(--text);background:none}
</style></head><body>${body}</body></html>`;
}

const ERRORS = {
  credentials: 'These credentials do not match our records.',
  locked: 'Too many attempts. The account is temporarily locked.',
  csrf: 'The form expired. Please try again.',
  validation: 'Please check the highlighted fields and try again.',
  username: 'That username is already taken.',
  email: 'That email address is already registered.',
  terms: 'You must accept the terms to continue.',
  rate: 'Too many attempts. Please wait a moment and try again.',
};

function loginPage(token, error, notice) {
  return page({
    title: 'Sign in',
    body: `<div class="card">
  <div class="brand"><span class="mark">S</span><span>Scalp<span style="color:var(--accent)">Sphere</span></span></div>
  <h1>Welcome back</h1>
  <p class="sub">Sign in to your account.</p>
  ${error && ERRORS[error] ? `<p class="err" role="alert">${esc(ERRORS[error])}</p>` : ''}
  ${notice ? `<p class="ok" role="status">${esc(notice)}</p>` : ''}
  <form method="POST" action="/login" novalidate>
    <input type="hidden" name="_token" value="${esc(token)}">
    <label for="email">Email</label>
    <input id="email" type="email" name="email" required autocomplete="email" autofocus placeholder="Email">
    <label for="password">Password</label>
    <input id="password" type="password" name="password" required autocomplete="current-password" placeholder="Password">
    <div class="chk"><input id="remember" name="remember" type="checkbox" value="1"><label for="remember" style="margin:0;font-weight:400">Remember me</label></div>
    <button type="submit">Sign in</button>
  </form>
  <p class="fine">New here? <a href="/register">Create an account</a></p>
</div>`,
  });
}

function registerPage(token, error) {
  return page({
    title: 'Create account',
    body: `<div class="card">
  <div class="brand"><span class="mark">S</span><span>Scalp<span style="color:var(--accent)">Sphere</span></span></div>
  <h1>Create your account</h1>
  <p class="sub">All balances shown in this environment are demo figures.</p>
  ${error && ERRORS[error] ? `<p class="err" role="alert">${esc(ERRORS[error])}</p>` : ''}
  <form method="POST" action="/register" novalidate>
    <input type="hidden" name="_token" value="${esc(token)}">
    <label for="name">Full name</label>
    <input id="name" type="text" name="name" required autocomplete="name" placeholder="Full name">
    <label for="username">Username</label>
    <input id="username" type="text" name="username" required autocomplete="username" placeholder="3–60 characters: a–z, 0–9, dot, dash, underscore">
    <label for="email">Email</label>
    <input id="email" type="email" name="email" required autocomplete="email" placeholder="Email">
    <label for="password">Password</label>
    <input id="password" type="password" name="password" required autocomplete="new-password" placeholder="At least 12 characters">
    <label for="password-confirm">Confirm password</label>
    <input id="password-confirm" type="password" name="password_confirmation" required autocomplete="new-password" placeholder="Repeat your password">
    <div class="chk"><input id="privacy" name="privacy" type="checkbox" value="1" required><label for="privacy" style="margin:0;font-weight:400">I accept the terms and privacy policy</label></div>
    <button type="submit">Create account</button>
  </form>
  <p class="fine">Already registered? <a href="/login">Sign in</a></p>
</div>`,
  });
}

function accountPage(user) {
  return page({
    title: 'My account',
    body: `<div class="card" style="width:min(560px,100%)">
  <nav class="top">
    <div class="brand"><span class="mark">S</span><span>Scalp<span style="color:var(--accent)">Sphere</span></span></div>
    <form class="inline" method="POST" action="/logout">
      <input type="hidden" name="_token" value="${esc(user._csrfToken)}">
      <button class="ghost" type="submit">Sign out</button>
    </form>
  </nav>
  <h1>Signed in</h1>
  <p class="sub">Session established. This page proves the form flow and the JSON API share one identity.</p>
  <dl class="dl">
    <dt>Reference</dt><dd>${esc(user.public_ref)}</dd>
    <dt>Name</dt><dd>${esc(user.full_name)}</dd>
    <dt>Username</dt><dd>${esc(user.username ?? '—')}</dd>
    <dt>Email</dt><dd>${esc(user.email)}</dd>
    <dt>KYC status</dt><dd>${esc(user.kyc_status)}</dd>
  </dl>
  <div class="kv"><span style="color:var(--dim);font-size:11px">Balance (demo)</span><b>${esc((Number(user.balance_minor ?? 0) / 100).toFixed(2))} USD</b></div>
  <p class="fine">The full customer API is under <code>/api/v1/customer/…</code> — same session, JSON responses.</p>
</div>`,
  });
}

// ---------------------------------------------------------------------------
export function createWebAuthModule({ repos }) {
  const requireCustomer = authenticateCustomer({ repos });

  /** Issues the CSRF cookie + value pair used by both forms. */
  function issueCsrf(res) {
    const token = randomToken(32);
    res.cookie(CSRF_COOKIE_NAME, token, csrfCookieOptions());
    return token;
  }

  /** Double-submit check: the _token FIELD must equal the csrf_token COOKIE. */
  function csrfOk(req) {
    const cookieToken = req.cookies?.[CSRF_COOKIE_NAME];
    const formToken = req.body?._token;
    if (typeof cookieToken !== 'string' || typeof formToken !== 'string') return false;
    if (cookieToken.length < 16 || formToken.length < 16) return false;
    return safeEqualHex(
      Buffer.from(cookieToken, 'utf8').toString('hex'),
      Buffer.from(formToken, 'utf8').toString('hex'),
    );
  }

  function webSessionCookieOptions(remember) {
    return {
      httpOnly: true,
      secure: env.cookies.secure,
      sameSite: 'lax', // the form flow navigates between pages, not just fetches
      domain: env.cookies.domain,
      path: '/',
      // "remember" extends the cookie's lifetime to the token's own TTL.
      maxAge: remember === '1' ? accessTtlSeconds() * 1000 * 4 : undefined,
    };
  }

  return function register(router) {
    router.get('/login', (req, res) => {
      const token = issueCsrf(res);
      res.status(200).type('html').send(loginPage(token, req.query?.error, req.query?.notice === 'registered' ? 'Account created. Please sign in.' : null));
    });

    router.post('/login', asyncHandler(async (req, res) => {
      if (!csrfOk(req)) return res.redirect(303, '/login?error=csrf');
      const email = String(req.body?.email ?? '').trim().toLowerCase();
      const password = String(req.body?.password ?? '');
      const remember = req.body?.remember === '1' ? '1' : undefined;

      if (!email || !password) return res.redirect(303, '/login?error=validation');

      const record = await repos.customerAuthRepo.findActiveByUserEmail(email);
      const matches = await verifyPassword(password, record ? record.password_hash : DUMMY_HASH);

      if (!record || !matches) {
        if (record) {
          const updated = await repos.customerAuthRepo.recordLoginFailure(
            record.user_id,
            env.auth.loginMaxAttempts,
            new Date(Date.now() + env.auth.loginLockoutMinutes * 60 * 1000),
          );
          if (updated.locked_until && new Date(updated.locked_until) > new Date()) {
            return res.redirect(303, '/login?error=locked');
          }
        }
        return res.redirect(303, '/login?error=credentials');
      }
      if (record.locked_until && new Date(record.locked_until) > new Date()) {
        return res.redirect(303, '/login?error=locked');
      }
      if (record.status !== 'active' || record.user_status !== 'active') {
        return res.redirect(303, '/login?error=credentials');
      }

      await repos.customerAuthRepo.recordLoginSuccess(record.user_id);

      const user = await repos.userRepo.findById(record.user_id);
      const accessToken = signCustomerAccessToken(user ?? {
        id: record.user_id, email: record.email, full_name: record.full_name,
      });

      res.cookie(WEB_SESSION_COOKIE, accessToken, webSessionCookieOptions(remember));
      return res.redirect(303, '/account');
    }));

    router.get('/register', (req, res) => {
      const token = issueCsrf(res);
      res.status(200).type('html').send(registerPage(token, req.query?.error));
    });

    router.post('/register', asyncHandler(async (req, res) => {
      if (!csrfOk(req)) return res.redirect(303, '/register?error=csrf');

      const name = String(req.body?.name ?? '').trim();
      const username = String(req.body?.username ?? '').trim().toLowerCase();
      const email = String(req.body?.email ?? '').trim().toLowerCase();
      const password = String(req.body?.password ?? '');
      const confirmation = String(req.body?.password_confirmation ?? '');
      const privacy = req.body?.privacy;

      if (!name || name.length < 2 || name.length > 120) return res.redirect(303, '/register?error=validation');
      if (!USERNAME_RE.test(username)) return res.redirect(303, '/register?error=validation');
      if (!EMAIL_RE.test(email) || email.length > 254) return res.redirect(303, '/register?error=validation');
      if (password !== confirmation) return res.redirect(303, '/register?error=validation');
      if (passwordPolicyErrors(password).length > 0) return res.redirect(303, '/register?error=validation');
      if (!privacy) return res.redirect(303, '/register?error=terms');

      if (await repos.userRepo.findByEmail(email)) return res.redirect(303, '/register?error=email');
      if (await repos.userRepo.findByUsername(username)) return res.redirect(303, '/register?error=username');

      const id = uuid();
      try {
        await repos.userRepo.create({
          id, fullName: name, email, username,
          balanceMinor: 0, status: 'active', kycStatus: 'pending', isDemo: 0,
        });
        await repos.customerAuthRepo.create({
          userId: id,
          passwordHash: await hashPassword(password),
        });
      } catch (err) {
        const msg = String(err.message ?? '');
        if (/username/i.test(msg)) return res.redirect(303, '/register?error=username');
        if (/email/i.test(msg)) return res.redirect(303, '/register?error=email');
        return res.redirect(303, '/register?error=validation');
      }

      // Sign the new customer straight in, mirroring the product's flow.
      const user = await repos.userRepo.findById(id);
      const accessToken = signCustomerAccessToken(user);
      res.cookie(WEB_SESSION_COOKIE, accessToken, webSessionCookieOptions('1'));
      return res.redirect(303, '/account');
    }));

    // Everything below requires a signed-in customer.
    router.get('/account', requireCustomer, asyncHandler(async (req, res) => {
      const user = await repos.userRepo.findById(req.customerAuth.userId);
      if (!user) return res.redirect(303, '/login');
      res.status(200).type('html').send(accountPage({
        ...user,
        _csrfToken: req.cookies?.[CSRF_COOKIE_NAME] ?? '',
      }));
    }));

    router.post('/logout', (req, res) => {
      res.clearCookie(WEB_SESSION_COOKIE, { ...webSessionCookieOptions(), maxAge: undefined });
      res.cookie(CSRF_COOKIE_NAME, '', { ...csrfCookieOptions(), maxAge: 0 });
      return res.redirect(303, '/login?notice=signedout');
    });

    return router;
  };
}
