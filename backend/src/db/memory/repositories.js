/**
 * In-memory implementation of the repository contract.
 *
 * Enforces the same NOT NULL / UNIQUE / CHECK / FOREIGN KEY rules as
 * `migrations/001_schema.sql` so a bug that only exists in the SQL layer is not
 * silently masked by the tests.
 *
 * Method names, arguments and return shapes are identical to
 * `src/db/mysql/repositories.js`; services are written against that contract
 * only and never against a concrete driver.
 */
import { createMemoryStore } from './memoryStore.js';

const ENUMS = {
  admins: {
    role: ['owner', 'admin', 'support'],
    status: ['active', 'disabled'],
  },
  users: {
    status: ['active', 'inactive'],
    kyc_status: ['pending', 'verified', 'rejected'],
  },
  withdrawals: {
    status: ['pending', 'processed', 'failed', 'cancelled'],
  },
  payment_methods: {
    type: ['crypto', 'currency'],
    used_for: ['deposit', 'withdraw', 'both'],
    status: ['enabled', 'disabled'],
  },
};

function toDate(v) {
  if (v instanceof Date) return v;
  if (v === null || v === undefined || v === '') return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function iife(fn) {
  return fn();
}

export function createMemoryRepositories(store = createMemoryStore()) {
  // -------------------------------------------------------------------------
  // helpers
  // -------------------------------------------------------------------------
  const table = (name) => store.table(name);

  function insertRow(name, row) {
    const cols = ENUMS[name] || {};
    for (const [col, allowed] of Object.entries(cols)) {
      store.assertCheck(
        row[col] === undefined || allowed.includes(row[col]),
        `Check constraint violated on ${name}.${col}: ${row[col]}`,
      );
    }
    if (name === 'users') {
      store.assertCheck(Number(row.balance_minor) >= 0, 'users.balance_minor must be >= 0');
    }
    if (name === 'withdrawals') {
      store.assertCheck(Number(row.amount_minor) > 0, 'withdrawals.amount_minor must be > 0');
      store.assertCheck(Number(row.fee_minor) >= 0, 'withdrawals.fee_minor must be >= 0');
      store.assertForeignKey(
        'users',
        (u) => u.id === row.user_id,
        `Foreign key fails: withdrawals.user_id = ${row.user_id}`,
      );
    }
    table(name).push(row);
    return clone(row);
  }

  const uniques = {
    admins: [['email']],
    users: [['email'], ['public_ref'], ['username']],
    withdrawals: [['public_ref']],
    payment_methods: [['name'], ['public_ref']],
  };

  function assertUniques(name, row, ignoreId) {
    for (const cols of uniques[name] || []) {
      for (const col of cols) {
        // MySQL semantics: a UNIQUE index ignores NULLs entirely, so multiple
        // rows may hold NULL. Without this, adding the nullable `username`
        // column made every demo user collide on NULL in the offline driver —
        // caught by the full suite going red, not by the new tests alone.
        if (row[col] === undefined || row[col] === null) continue;
        // MySQL's utf8mb4_0900_ai_ci collation is case-insensitive.
        const target = String(row[col]).toLowerCase();
        store.assertUnique(
          name,
          (r) => r.id !== ignoreId && String(r[col]).toLowerCase() === target,
          `Duplicate entry '${row[col]}' for key '${name}.${col}'`,
        );
      }
    }
  }

  function allocateRef(prefix) {
    const seq = table('ref_sequences');
    let row = seq.find((r) => r.entity_prefix === prefix);
    if (!row) {
      row = { entity_prefix: prefix, next_value: 1 };
      seq.push(row);
    }
    const value = row.next_value;
    row.next_value += 1;
    return `${prefix}-${String(value).padStart(5, '0')}`;
  }

  function likeMatch(value, term) {
    return String(value ?? '').toLowerCase().includes(term);
  }

  /**
 * Read paths return a SHALLOW COPY of the stored row.
 *
 * Without this, `before` / `after` snapshots taken around a write would alias
 * the same live object and the audit log could not show the previous value.
 */
const clone = (row) => (row ? { ...row } : row);
const cloneAll = (rows) => rows.map((row) => ({ ...row }));

function applySearch(rows, term, fields) {
    if (!term) return rows;
    return rows.filter((r) => fields.some((f) => likeMatch(r[f], term)));
  }

  function sortRows(rows, sortWhitelist, sort, direction) {
    const key = sortWhitelist[sort] ? sort : Object.keys(sortWhitelist)[0];
    const dir = String(direction).toLowerCase() === 'asc' ? 1 : -1;
    const getter = sortWhitelist[key];
    return [...rows].sort((a, b) => {
      const av = getter(a);
      const bv = getter(b);
      if (av === bv) return 0;
      if (av === null || av === undefined) return 1;
      if (bv === null || bv === undefined) return -1;
      return av > bv ? dir : -dir;
    });
  }

  function paginate(rows, limit, offset) {
    return rows.slice(offset, offset + limit);
  }

  /**
   * Reproduces the SQL driver's `JOIN users` at read time: `client_name` and
   * `user_ref` are derived from the live `users` row, never cached on the
   * withdrawal at insert. Without this the two drivers would diverge the moment
   * a customer renamed themselves — MySQL would show the new name in the
   * withdrawal list and the offline driver would show the stale one. That is
   * exactly the divergence a customer/admin consistency test caught.
   */
  function withUserJoin(row) {
    if (!row) return null;
    const user = table('users').find((u) => u.id === row.user_id);
    return clone({ ...row, client_name: user?.full_name ?? null, user_ref: user?.public_ref ?? null });
  }

  // -------------------------------------------------------------------------
  // admins
  // -------------------------------------------------------------------------
  const adminRepo = {
    findByEmail(email) {
      const needle = String(email).toLowerCase();
      return clone(table('admins').find((a) => a.email.toLowerCase() === needle) ?? null);
    },
    findById(id) {
      return clone(table('admins').find((a) => a.id === id) ?? null);
    },
    count() {
      return table('admins').length;
    },
    create({ id, email, passwordHash, fullName, role = 'admin', status = 'active' }, tx) {
      assertUniques('admins', { id, email }, null);
      const now = new Date();
      return insertRow(
        'admins',
        {
          id,
          email,
          password_hash: passwordHash,
          full_name: fullName,
          role,
          status,
          failed_login_count: 0,
          locked_until: null,
          last_login_at: null,
          password_updated_at: now,
          created_at: now,
          updated_at: now,
        },
        tx,
      );
    },
    recordLoginSuccess(id, tx) {
      const admin = table('admins').find((a) => a.id === id);
      if (!admin) return null;
      admin.failed_login_count = 0;
      admin.locked_until = null;
      admin.last_login_at = new Date();
      admin.updated_at = new Date();
      return admin;
    },
    recordLoginFailure(id, maxAttempts, lockUntil, tx) {
      const admin = table('admins').find((a) => a.id === id);
      if (!admin) return null;
      admin.failed_login_count += 1;
      if (admin.failed_login_count >= maxAttempts) {
        admin.locked_until = lockUntil;
      }
      admin.updated_at = new Date();
      return admin;
    },
    clearLock(id, tx) {
      const admin = table('admins').find((a) => a.id === id);
      if (admin) {
        admin.failed_login_count = 0;
        admin.locked_until = null;
        admin.updated_at = new Date();
      }
      return admin;
    },
    setPassword(id, passwordHash, tx) {
      const admin = table('admins').find((a) => a.id === id);
      if (!admin) return null;
      admin.password_hash = passwordHash;
      admin.password_updated_at = new Date();
      admin.updated_at = new Date();
      return admin;
    },
  };

  // -------------------------------------------------------------------------
  // sessions
  // -------------------------------------------------------------------------
  const sessionRepo = {
    create({ id, adminId, refreshTokenHash, expiresAt, ip = null, userAgent = null }, tx) {
      return insertRow(
        'admin_sessions',
        {
          id,
          admin_id: adminId,
          refresh_token_hash: refreshTokenHash,
          issued_at: new Date(),
          expires_at: toDate(expiresAt),
          revoked_at: null,
          revoked_reason: null,
          ip,
          user_agent: userAgent,
        },
        tx,
      );
    },
    findValidByTokenHash(hash, now = new Date()) {
      return clone(
        table('admin_sessions').find(
          (s) => s.refresh_token_hash === hash && s.revoked_at === null && s.expires_at > now,
        ) ?? null,
      );
    },
    revoke(id, reason, now = new Date(), tx) {
      const s = table('admin_sessions').find((x) => x.id === id);
      if (s && s.revoked_at === null) {
        s.revoked_at = toDate(now) ?? new Date();
        s.revoked_reason = reason ?? null;
      }
      return s ?? null;
    },
    revokeForAdmin(adminId, reason, now = new Date(), tx) {
      let n = 0;
      for (const s of table('admin_sessions')) {
        if (s.admin_id === adminId && s.revoked_at === null) {
          s.revoked_at = toDate(now) ?? new Date();
          s.revoked_reason = reason ?? null;
          n += 1;
        }
      }
      return n;
    },
    deleteExpired(now = new Date(), tx) {
      const rows = table('admin_sessions');
      const before = rows.length;
      const kept = rows.filter((s) => s.expires_at > now);
      table('admin_sessions').length = 0;
      table('admin_sessions').push(...kept);
      return before - kept.length;
    },
  };

  // -------------------------------------------------------------------------
  // users
  // -------------------------------------------------------------------------
  const USER_SORTS = {
    created_at: (r) => r.created_at,
    balance: (r) => Number(r.balance_minor),
    name: (r) => String(r.full_name).toLowerCase(),
    id: (r) => r.public_ref,
  };

  const userRepo = {
    create({ id, fullName, email, username = null, balanceMinor = 0, currency = 'USD', status = 'active', kycStatus = 'pending', isDemo = 1 }, tx) {
      const publicRef = allocateRef('USR');
      const row = {
        id,
        public_ref: publicRef,
        full_name: fullName,
        email: String(email).toLowerCase(),
        username: username ? String(username).toLowerCase() : null,
        balance_minor: Number(balanceMinor),
        currency,
        status,
        kyc_status: kycStatus,
        is_demo: isDemo ? 1 : 0,
        created_at: new Date(),
        updated_at: new Date(),
      };
      assertUniques('users', row, null);
      return insertRow('users', row, tx);
    },
    findByUsername(username) {
      const needle = String(username).toLowerCase();
      return clone(table('users').find((u) => u.username === needle) ?? null);
    },
    findById(id) {
      return clone(
        table('users').find((u) => u.public_ref === id || u.id === id) ?? null,
      );
    },
    findByEmail(email) {
      const needle = String(email).toLowerCase();
      return clone(table('users').find((u) => u.email === needle) ?? null);
    },
    list({ search = '', status, kycStatus, sort = 'created_at', direction = 'desc', limit = 20, offset = 0 }, tx) {
      const term = String(search).trim().toLowerCase();
      let rows = applySearch(table('users'), term, ['full_name', 'email', 'public_ref']);
      if (status) rows = rows.filter((r) => r.status === status);
      if (kycStatus) rows = rows.filter((r) => r.kyc_status === kycStatus);
      const sorted = sortRows(rows, USER_SORTS, sort, direction);
      return {
        rows: cloneAll(paginate(sorted, limit, offset)),
        total: sorted.length,
        facets: {
          active: table('users').filter((r) => r.status === 'active').length,
          inactive: table('users').filter((r) => r.status === 'inactive').length,
          kyc_pending: table('users').filter((r) => r.kyc_status === 'pending').length,
          kyc_verified: table('users').filter((r) => r.kyc_status === 'verified').length,
        },
      };
    },
    async recent(limit = 5, tx) {
      return [...table('users')]
        .sort((a, b) => b.created_at - a.created_at)
        .slice(0, Math.max(0, limit));
    },
    countAll() {
      return table('users').length;
    },
    updateFullName(id, fullName, tx) {
      const row = table('users').find((u) => u.id === id);
      if (!row) return null;
      row.full_name = fullName;
      row.updated_at = new Date();
      return clone(row);
    },
    countCreatedBetween(from, to) {
      return table('users').filter((u) => u.created_at >= from && u.created_at < to).length;
    },
  };

  // -------------------------------------------------------------------------
  // withdrawals
  // -------------------------------------------------------------------------
  const WITHDRAWAL_SORTS = {
    created_at: (r) => r.created_at,
    amount: (r) => Number(r.amount_minor),
    fee: (r) => Number(r.fee_minor),
    status: (r) => r.status,
    id: (r) => r.public_ref,
  };

  const withdrawalRepo = {
    create(
      {
        id,
        userId,
        amountMinor,
        feeMinor = 0,
        method,
        receiverEmail,
        status = 'pending',
        isDemo = 1,
      },
      tx,
    ) {
      const publicRef = allocateRef('WDR');
      const row = {
        id,
        public_ref: publicRef,
        user_id: userId,
        amount_minor: Number(amountMinor),
        fee_minor: Number(feeMinor),
        method,
        receiver_email: String(receiverEmail).toLowerCase(),
        status,
        is_demo: isDemo ? 1 : 0,
        created_at: new Date(),
        updated_at: new Date(),
        // Denormalised for the list/search query, mirroring the JOIN columns the
        // SQL driver produces (u.public_ref AS user_ref, u.full_name AS
        // client_name). Without user_ref the two drivers would diverge and any
        // cross-check between the admin list and a customer's own records would
        // pass against MySQL but fail offline — which is exactly how this gap
        // was found.
        client_name: table('users').find((u) => u.id === userId)?.full_name ?? null,
        user_ref: table('users').find((u) => u.id === userId)?.public_ref ?? null,
      };
      assertUniques('withdrawals', row, null);
      return insertRow('withdrawals', row, tx);
    },
    findById(id) {
      return withUserJoin(
        table('withdrawals').find((w) => w.public_ref === id || w.id === id) ?? null,
      );
    },
    /**
     * Ownership-checked single fetch. Null when the record does not exist OR is
     * not owned by `userId`, so a caller cannot probe for other users' ids.
     */
    findByIdForUser(id, userId, tx) {
      return withUserJoin(
        table('withdrawals').find(
          (w) => (w.public_ref === id || w.id === id) && w.user_id === userId,
        ) ?? null,
      );
    },
    list({ search = '', status, method, from, to, userId, sort = 'created_at', direction = 'desc', limit = 20, offset = 0 }, tx) {
      const term = String(search).trim().toLowerCase();
      let rows = applySearch(table('withdrawals'), term, [
        'public_ref',
        'client_name',
        'method',
        'receiver_email',
        'amount_minor',
      ]);
      if (userId) rows = rows.filter((r) => r.user_id === userId);
      if (status) rows = rows.filter((r) => r.status === status);
      if (method) rows = rows.filter((r) => r.method === method);
      if (from) rows = rows.filter((r) => toDate(r.created_at) >= new Date(from));
      if (to) rows = rows.filter((r) => toDate(r.created_at) <= new Date(to));
      const sorted = sortRows(rows, WITHDRAWAL_SORTS, sort, direction);
      return {
        rows: paginate(sorted, limit, offset).map(withUserJoin),
        total: sorted.length,
        summary: {
          pending_count: table('withdrawals').filter((r) => r.status === 'pending').length,
          pending_amount_minor: table('withdrawals')
            .filter((r) => r.status === 'pending')
            .reduce((sum, r) => sum + Number(r.amount_minor), 0),
          processed_count: table('withdrawals').filter((r) => r.status === 'processed').length,
        },
      };
    },
    async distinctMethods(tx) {
      return [...new Set(table('withdrawals').map((w) => w.method))].sort((a, b) =>
        String(a).localeCompare(String(b)),
      );
    },

    async recentForUser(userId, limit = 5, tx) {
      return table('withdrawals')
        .filter((w) => w.user_id === userId)
        .sort((a, b) => b.created_at - a.created_at)
        .slice(0, Math.max(0, limit))
        .map(withUserJoin);
    },

    pendingAggregate(now = new Date(), tx) {
      const rows = table('withdrawals').filter((w) => w.status === 'pending');
      return {
        count: rows.length,
        amount_minor: rows.reduce((sum, r) => sum + Number(r.amount_minor), 0),
      };
    },
  };

  // -------------------------------------------------------------------------
  // payment methods
  // -------------------------------------------------------------------------
  const METHOD_SORTS = {
    created_at: (r) => r.created_at,
    name: (r) => String(r.name).toLowerCase(),
    status: (r) => r.status,
    type: (r) => r.type,
    id: (r) => r.public_ref,
  };

  const paymentMethodRepo = {
    create({ id, name, type, usedFor, status = 'disabled', isDemo = 0 }, tx) {
      const publicRef = allocateRef('PAY');
      const row = {
        id,
        public_ref: publicRef,
        name,
        type,
        used_for: usedFor,
        status,
        is_demo: isDemo ? 1 : 0,
        created_at: new Date(),
        updated_at: new Date(),
      };
      assertUniques('payment_methods', row, null);
      return insertRow('payment_methods', row, tx);
    },
    findById(id) {
      return clone(
        table('payment_methods').find((m) => m.public_ref === id || m.id === id) ?? null,
      );
    },
    findByName(name) {
      const needle = String(name).trim().toLowerCase();
      return clone(table('payment_methods').find((m) => m.name.toLowerCase() === needle) ?? null);
    },
    list({ search = '', type, usedFor, status, sort = 'created_at', direction = 'desc', limit = 20, offset = 0 }, tx) {
      const term = String(search).trim().toLowerCase();
      let rows = applySearch(table('payment_methods'), term, ['name', 'public_ref']);
      if (type) rows = rows.filter((r) => r.type === type);
      if (usedFor) rows = rows.filter((r) => r.used_for === usedFor);
      if (status) rows = rows.filter((r) => r.status === status);
      const sorted = sortRows(rows, METHOD_SORTS, sort, direction);
      return {
        rows: cloneAll(paginate(sorted, limit, offset)),
        total: sorted.length,
        facets: {
          enabled: table('payment_methods').filter((r) => r.status === 'enabled').length,
          disabled: table('payment_methods').filter((r) => r.status === 'disabled').length,
          crypto: table('payment_methods').filter((r) => r.type === 'crypto').length,
          currency: table('payment_methods').filter((r) => r.type === 'currency').length,
        },
      };
    },
    update(id, patch, tx) {
      const row = table('payment_methods').find((m) => m.id === id || m.public_ref === id);
      if (!row) return null;
      for (const [k, v] of Object.entries(patch)) {
        if (v !== undefined) row[k] = v;
      }
      row.updated_at = new Date();
      return clone(row);
    },
    remove(id, tx) {
      const rows = table('payment_methods');
      const idx = rows.findIndex((m) => m.id === id || m.public_ref === id);
      if (idx === -1) return false;
      rows.splice(idx, 1);
      return true;
    },
    distinctNames() {
      return [...new Set(table('payment_methods').map((m) => m.name))];
    },
  };

  // -------------------------------------------------------------------------
  // payment settings (singleton)
  // -------------------------------------------------------------------------
  const settingsRepo = {
    get(tx) {
      return clone(table('payment_settings')[0] ?? null);
    },
    ensure(tx) {
      let row = table('payment_settings')[0];
      if (row) return clone(row);
      row = {
        id: 1,
        default_currency: 'USD',
        processing_mode: 'automatic',
        payment_instructions: null,
        minimum_deposit_minor: 1000,
        minimum_withdrawal_minor: 1000,
        updated_by: null,
        created_at: new Date(),
        updated_at: new Date(),
      };
      table('payment_settings').push(row);
      return clone(row);
    },
    upsert(patch, adminId, tx) {
      const stored = table('payment_settings')[0] ?? settingsRepo.ensure(tx);
      for (const [k, v] of Object.entries(patch)) {
        if (v !== undefined && k !== 'id') stored[k] = v;
      }
      stored.updated_by = adminId ?? stored.updated_by ?? null;
      stored.updated_at = new Date();
      return clone(stored);
    },
  };

  // -------------------------------------------------------------------------
  // platform metrics (demo aggregates only — never written by the app)
  // -------------------------------------------------------------------------
  const metricsRepo = {
    sumByKey(key, { from, to }, tx) {
      const rows = table('platform_metrics_daily').filter((r) => {
        if (r.metric_key !== key) return false;
        const d = toDate(r.metric_date);
        if (from && d < new Date(from)) return false;
        if (to && d > new Date(to)) return false;
        return true;
      });
      return {
        amount_minor: rows.reduce((s, r) => s + Number(r.amount_minor), 0),
        count_value: rows.reduce((s, r) => s + Number(r.count_value), 0),
        is_demo: rows.every((r) => Number(r.is_demo) === 1),
        rows: rows.length,
      };
    },
    series({ from, to }, tx) {
      const deposits = new Map();
      const withdrawals = new Map();
      for (const r of table('platform_metrics_daily')) {
        const d = toDate(r.metric_date);
        if (!d) continue;
        if (from && d < new Date(from)) continue;
        if (to && d > new Date(to)) continue;
        const key = r.metric_date;
        if (r.metric_key === 'deposits') deposits.set(key, Number(r.amount_minor));
        if (r.metric_key === 'withdrawals') withdrawals.set(key, Number(r.amount_minor));
      }
      const dates = [...new Set([...deposits.keys(), ...withdrawals.keys()])].sort();
      return dates.map((date) => ({
        date,
        deposits_minor: deposits.get(date) ?? 0,
        withdrawals_minor: withdrawals.get(date) ?? 0,
        is_demo: true,
      }));
    },
    seedDemoRows(rows, tx) {
      for (const r of rows) {
        const existing = table('platform_metrics_daily').find(
          (x) => x.metric_date === r.metric_date && x.metric_key === r.metric_key,
        );
        if (existing) Object.assign(existing, r);
        else table('platform_metrics_daily').push(r);
      }
      return rows.length;
    },
    clearAll(tx) {
      table('platform_metrics_daily').length = 0;
    },
  };

  // -------------------------------------------------------------------------
  // audit log
  // -------------------------------------------------------------------------
  const auditRepo = {
    insert(entry, tx) {
      const row = { id: store.nextAutoId('audit_log'), created_at: new Date(), ...entry };
      table('audit_log').push(row);
      return row;
    },
    list({ page = 1, perPage = 20, action, entityType, from, to }, tx) {
      let rows = [...table('audit_log')].sort((a, b) => b.id - a.id);
      if (action) rows = rows.filter((r) => r.action === action);
      if (entityType) rows = rows.filter((r) => r.entity_type === entityType);
      if (from) rows = rows.filter((r) => r.created_at >= new Date(from));
      if (to) rows = rows.filter((r) => r.created_at <= new Date(to));
      return { rows: rows.slice((page - 1) * perPage, page * perPage), total: rows.length };
    },
    count(tx) {
      return table('audit_log').length;
    },
    clearAll(tx) {
      table('audit_log').length = 0;
    },
  };

  // -------------------------------------------------------------------------
  // customer portal credentials — mirrors src/db/mysql/repositories.js
  // -------------------------------------------------------------------------
  const customerAuthRepo = {
    findByUserId(userId) {
      return clone(table('customer_auth').find((c) => c.user_id === userId) ?? null);
    },

    /**
     * Credential row joined with its `users` row, or null if either is absent.
     * Keeps the customer portal and the admin panel on one shared identity.
     */
    findActiveByUserEmail(email) {
      const needle = String(email).toLowerCase();
      const cred = table('customer_auth').find((c) => {
        const user = table('users').find((u) => u.id === c.user_id);
        return user && user.email === needle;
      });
      if (!cred) return null;
      const user = table('users').find((u) => u.id === cred.user_id);
      if (!user) return null;
      return clone({
        ...cred,
        public_ref: user.public_ref,
        full_name: user.full_name,
        email: user.email,
        balance_minor: user.balance_minor,
        currency: user.currency,
        user_status: user.status,
        kyc_status: user.kyc_status,
        user_created_at: user.created_at,
      });
    },

    create({ userId, passwordHash }, tx) {
      const now = new Date();
      const row = {
        user_id: userId,
        password_hash: passwordHash,
        status: 'active',
        failed_login_count: 0,
        locked_until: null,
        password_updated_at: now,
        last_login_at: null,
        created_at: now,
        updated_at: now,
      };
      table('customer_auth').push(row);
      return clone(row);
    },

    setPassword(userId, passwordHash, tx) {
      const row = table('customer_auth').find((c) => c.user_id === userId);
      if (!row) return null;
      row.password_hash = passwordHash;
      row.password_updated_at = new Date();
      row.failed_login_count = 0;
      row.locked_until = null;
      row.updated_at = new Date();
      return clone(row);
    },

    recordLoginSuccess(userId, tx) {
      const row = table('customer_auth').find((c) => c.user_id === userId);
      if (!row) return null;
      row.failed_login_count = 0;
      row.locked_until = null;
      row.last_login_at = new Date();
      row.updated_at = new Date();
      return clone(row);
    },

    recordLoginFailure(userId, maxAttempts, lockUntil, tx) {
      const row = table('customer_auth').find((c) => c.user_id === userId);
      if (!row) return null;
      row.failed_login_count += 1;
      if (row.failed_login_count >= maxAttempts) {
        row.locked_until = toDate(lockUntil) ?? new Date();
      }
      row.updated_at = new Date();
      return clone(row);
    },
  };

  const customerSessionRepo = {
    create({ id, userId, refreshTokenHash, expiresAt, ip = null, userAgent = null }, tx) {
      const row = {
        id,
        user_id: userId,
        refresh_token_hash: refreshTokenHash,
        issued_at: new Date(),
        expires_at: toDate(expiresAt),
        revoked_at: null,
        revoked_reason: null,
        ip,
        user_agent: userAgent,
      };
      table('customer_sessions').push(row);
      return clone(row);
    },

    findValidByTokenHash(hash, now = new Date()) {
      return clone(
        table('customer_sessions').find(
          (s) => s.refresh_token_hash === hash && s.revoked_at === null && s.expires_at > now,
        ) ?? null,
      );
    },

    revoke(id, reason, now = new Date(), tx) {
      const s = table('customer_sessions').find((x) => x.id === id);
      if (s && s.revoked_at === null) {
        s.revoked_at = toDate(now) ?? new Date();
        s.revoked_reason = reason ?? null;
      }
      return s ? clone(s) : null;
    },

    revokeForUser(userId, reason, now = new Date(), tx) {
      let n = 0;
      for (const s of table('customer_sessions')) {
        if (s.user_id === userId && s.revoked_at === null) {
          s.revoked_at = toDate(now) ?? new Date();
          s.revoked_reason = reason ?? null;
          n += 1;
        }
      }
      return n;
    },

    deleteExpired(now = new Date(), tx) {
      const rows = table('customer_sessions');
      const before = rows.length;
      const kept = rows.filter((s) => s.expires_at > now);
      table('customer_sessions').length = 0;
      table('customer_sessions').push(...kept);
      return before - kept.length;
    },
  };

  const repositories = {
    adminRepo,
    sessionRepo,
    userRepo,
    withdrawalRepo,
    paymentMethodRepo,
    settingsRepo,
    metricsRepo,
    auditRepo,
    customerAuthRepo,
    customerSessionRepo,
  };

  return {
    dialect: 'memory',
    store,
    repositories,
    transaction: async (handler) => {
      store.begin();
      try {
        const result = await handler({ id: store.now().toISOString() });
        store.commit();
        return result;
      } catch (err) {
        store.rollback();
        throw err;
      }
    },
    close: async () => {},
    truncateAll: () => store.truncateAll(),
  };
}
