/**
 * Centralised API client. THE ONLY place in this app that talks to the network.
 *
 * Contract it implements (from backend/docs/API_CONTRACT.md and openapi.yaml):
 *   - Envelope: { success, data, meta? } / { success:false, error:{code,message,details?,request_id} }
 *   - Auth: httpOnly cookies (access_token, refresh_token) + double-submit CSRF
 *     (X-CSRF-Token header echoing the readable csrf_token cookie) on writes.
 *   - Session expiry: on 401 it attempts ONE POST /auth/refresh, then retries
 *     the original request once. If that fails the session is gone and the
 *     user is sent to the login page.
 *   - 403/FORBIDDEN surfaces as a distinct "permission" error so views can show
 *     a permission-denied state instead of a generic failure.
 *
 * Safety rules enforced here:
 *   - credentials are never logged; request bodies are never logged
 *   - no token or password is ever written to localStorage/sessionStorage
 *   - all state-changing requests automatically carry the CSRF header
 */
(() => {
  const cfg = window.__SS_CONFIG__ ?? {};
  const BASE = String(cfg.apiBase ?? '').replace(/\/$/, '') + '/api/v1';

  const UNSAFE = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

  function getCookie(name) {
    const prefix = `${name}=`;
    for (const part of document.cookie.split(';')) {
      const kv = part.trim();
      if (kv.startsWith(prefix)) return kv.slice(prefix.length);
    }
    return '';
  }

  /** Builds a query string, skipping empty values. */
  function qs(query) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v === undefined || v === null || v === '') continue;
      params.set(k, String(v));
    }
    const s = params.toString();
    return s ? `?${s}` : '';
  }

  class ApiError extends Error {
    constructor(status, code, message, details, requestId) {
      super(message || 'Request failed.');
      this.name = status === 403 ? 'PermissionError' : 'ApiError';
      this.status = status;
      this.code = code ?? 'UNKNOWN';
      this.details = details ?? null;
      this.requestId = requestId ?? null;
      this.permission = status === 403;
    }
  }

  /** Maps a raw response body onto the error the UI should display. */
  function toApiError(status, body) {
    const err = body?.error;
    const code = err?.code ?? '';
    let message = err?.message ?? `Request failed with status ${status}.`;

    // Friendly, non-leaking wording for the codes an operator can actually hit.
    if (status === 429) message = 'Too many requests. Please wait a moment and try again.';
    if (status === 502 || code === 'SERVICE_UNAVAILABLE') {
      message = 'Cannot reach the API. Check that the backend is running.';
    }
    return new ApiError(status, code, message, err?.details, err?.request_id);
  }

  let refreshing = null;

  /** One in-flight refresh at a time, shared across concurrent 401s. */
  function refreshSession() {
    if (!refreshing) {
      refreshing = request('POST', '/auth/refresh', { retry: false }).finally(() => {
        refreshing = null;
      });
    }
    return refreshing;
  }

  async function request(method, path, { query, body, retry = true } = {}) {
    const url = `${BASE}${path}${qs(query)}`;
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (UNSAFE.has(method)) {
      const token = getCookie('csrf_token');
      if (token) headers['X-CSRF-Token'] = token;
    }

    let res;
    try {
      res = await fetch(url, {
        method,
        headers,
        credentials: 'include',
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (networkErr) {
      // fetch() throws only on network/DNS/CORS failure — never on a status.
      // Log the path only; never the body, which may contain credentials.
      console.warn(`[api] ${method} ${path} network error`);
      throw new ApiError(0, 'NETWORK_ERROR', 'Cannot reach the API. Check your connection.');
    }

    if (res.status === 204) return { status: 204, data: null, meta: null };

    let json = null;
    try {
      json = await res.json();
    } catch {
      /* non-JSON body — fall through to the status handling below */
    }

    // Session expired: try one silent refresh, then retry the original call.
    if (res.status === 401 && retry && path !== '/auth/login' && path !== '/auth/refresh') {
      let recovered = false;
      try {
        await refreshSession();
        recovered = true;
      } catch {
        recovered = false;
      }
      if (recovered) return request(method, path, { query, body, retry: false });

      // Genuinely signed out. Only the login page may host an anonymous user.
      if (!location.pathname.endsWith('login.html')) {
        location.href = `login.html?expired=1`;
      }
      throw new ApiError(401, json?.error?.code ?? 'UNAUTHENTICATED', 'Your session has expired. Please sign in again.');
    }

    if (!res.ok || json?.success === false) {
      console.warn(`[api] ${method} ${path} -> ${res.status}`);
      throw toApiError(res.status, json);
    }

    return {
      status: res.status,
      data: json?.data ?? null,
      meta: json?.meta ?? null,
    };
  }

  // ---- Session helpers (all identity comes from the server, never storage) --
  const api = {
    request,
    BASE,

    async me() {
      const { data } = await request('GET', '/auth/me');
      return data;
    },

    async health() {
      const { data } = await request('GET', '/health');
      return data;
    },

    async login(email, password) {
      return request('POST', '/auth/login', { body: { email, password } });
    },

    async logout() {
      return request('POST', '/auth/logout');
    },

    async logoutAll() {
      return request('POST', '/auth/logout-all');
    },

    async changePassword(currentPassword, newPassword) {
      return request('POST', '/auth/change-password', {
        body: { current_password: currentPassword, new_password: newPassword },
      });
    },

    /** Everything the API can tell us about an error, for display. */
    describe(error) {
      const bits = [error.message];
      if (error.code && error.code !== 'UNKNOWN') bits.push(`(${error.code})`);
      if (error.requestId) bits.push(`ref ${error.requestId}`);
      return bits.join(' ');
    },
  };

  window.SS = api;
})();
