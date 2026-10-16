/**
 * In-process data store + unit-of-work used by the automated test suite.
 *
 * WHY THIS EXISTS
 * ---------------
 * The production driver is `mysql` (parameterized SQL, see
 * `src/db/mysql/repositories.js`). The brief requires "a way to run automated
 * tests against a test database without touching production data". Two modes
 * are supported:
 *
 *   DB_DRIVER=memory  (NODE_ENV=test)  — zero external services; the full HTTP
 *                                         contract, auth, CSRF, validation,
 *                                         pagination and audit behaviour is
 *                                         exercised end-to-end in CI.
 *   DB_DRIVER=mysql   (NODE_ENV=test)  — the same tests run against a real,
 *                                         disposable `scalpsphere_test` schema
 *                                         (see docs/TESTING.md).
 *
 * This module implements the repository contract in memory, with the same
 * checks and constraints as the SQL schema, plus snapshot-based transactions so
 * rollback behaviour is genuinely tested.
 *
 * IT IS NOT DURABLE. The config layer refuses DB_DRIVER=memory unless
 * NODE_ENV=test.
 */

import { randomUUID } from 'node:crypto';

const TABLES = [
  'admins',
  'admin_sessions',
  'users',
  'withdrawals',
  'payment_methods',
  'payment_settings',
  'platform_metrics_daily',
  'audit_log',
  'ref_sequences',
  'customer_auth',
  'customer_sessions',
];

function nowIso() {
  return new Date().toISOString();
}

export function createMemoryStore() {
  const tables = new Map(TABLES.map((t) => [t, []]));
  const autoId = new Map();
  let snapshot = null;

  const store = {
    dialect: 'memory',
    now: () => new Date(),

    table(name) {
      if (!tables.has(name)) throw new Error(`Unknown table: ${name}`);
      return tables.get(name);
    },

    nextAutoId(name) {
      const n = (autoId.get(name) ?? 0) + 1;
      autoId.set(name, n);
      return n;
    },

    // --- constraint checks shared with the SQL schema ---------------------
    assertUnique(table, predicate, message) {
      if (store.table(table).some(predicate)) {
        const err = new Error(message);
        err.code = 'ER_DUP_ENTRY';
        err.constraint = true;
        throw err;
      }
    },

    assertCheck(condition, message) {
      if (!condition) {
        const err = new Error(message);
        err.code = 'ER_CHECK_CONSTRAINT_VIOLATED';
        err.constraint = true;
        throw err;
      }
    },

    assertForeignKey(table, predicate, message) {
      if (!store.table(table).some(predicate)) {
        const err = new Error(message);
        err.code = 'ER_NO_REFERENCED_ROW_2';
        err.constraint = true;
        throw err;
      }
    },

    // --- unit of work -----------------------------------------------------
    begin() {
      snapshot = new Map(TABLES.map((t) => [t, store.table(t).map((r) => ({ ...r }))]));
      return { id: cryptoRandom('txn') };
    },

    commit() {
      snapshot = null;
    },

    rollback() {
      if (snapshot) {
        for (const [name, rows] of snapshot) tables.set(name, rows);
      }
      snapshot = null;
    },

    /** Wipe everything (test bootstrap / seed --reset). */
    truncateAll() {
      for (const t of TABLES) tables.set(t, []);
      autoId.clear();
    },

    _iso: nowIso,
  };

  return store;
}

function cryptoRandom(prefix) {
  return `${prefix}_${randomUUID()}`;
}
