/**
 * Runtime configuration for the admin UI.
 *
 * API base URL: `''` means SAME ORIGIN — the pages are served from the same
 * host as the API (the dev proxy in serve.mjs, or nginx in production), which
 * is what the backend's httpOnly SameSite=Strict cookies require.
 *
 * There is deliberately NO hardcoded production domain. If the API lives on a
 * different origin, set `apiBase` here or serve a modified copy of this file
 * from your web server — and add that origin to the backend's
 * CORS_ALLOWED_ORIGINS, with COOKIE_SAMESITE adjusted accordingly.
 */
window.__SS_CONFIG__ = {
  /** e.g. '' (same origin, the default) or 'https://api.example.com' */
  apiBase: '',

  /** Branding shown in the top bar and on the login page. */
  productName: 'ScalpSphere',
  productSuffix: 'ADMIN',

  /** Frontend version, surfaced on the About page. Purely informational. */
  frontendVersion: '1.0.0',
};
