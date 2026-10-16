/**
 * MySQL connection pool.
 *
 * mysql2 is imported dynamically so that `npm test` (DB_DRIVER=memory) never
 * needs to resolve or open the driver.
 *
 * Configuration notes:
 *  - `decimalNumbers: true` keeps DECIMAL aggregates out of floating point;
 *    every aggregate is wrapped in Number() at the repository boundary.
 *  - `dateStrings: false` (default) returns JS Date objects for DATETIME.
 *  - A single pool is created per process; `close()` is used by tests.
 */
import mysql from 'mysql2/promise';

export async function createMysqlPool(dbConfig) {
  const pool = mysql.createPool({
    host: dbConfig.host,
    port: dbConfig.port,
    user: dbConfig.user,
    password: dbConfig.password,
    database: dbConfig.database,
    charset: dbConfig.charset,
    waitForConnections: true,
    connectionLimit: dbConfig.poolSize,
    connectTimeout: dbConfig.connectTimeoutMs,
    queueLimit: 0,
    decimalNumbers: true,
    namedPlaceholders: false,
    multipleStatements: false,
    ssl: dbConfig.ssl
      ? {
          // Managed hosts (Hostinger VPS with self-signed certs included) may
          // need `rejectUnauthorized: false`; set DB_SSL_CA to harden it.
          minVersion: 'TLSv1.2',
        }
      : undefined,
  });

  // Fail fast with a clear message rather than at first request time.
  const conn = await pool.getConnection();
  try {
    await conn.query('SELECT 1');
  } finally {
    conn.release();
  }

  return pool;
}

/**
 * Map driver errors onto safe HTTP errors. Raw SQL text, error codes and stack
 * traces are logged server-side only.
 */
export function describeMysqlError(err) {
  if (!err || typeof err !== 'object') return { kind: 'unknown', loggable: true };

  const code = err.code;
  switch (code) {
    case 'ER_DUP_ENTRY':
      return { kind: 'duplicate', constraint: true, loggable: false };
    case 'ER_NO_REFERENCED_ROW_2':
    case 'ER_ROW_IS_REFERENCED_2':
      return { kind: 'foreign_key', constraint: true, loggable: false };
    case 'ER_CHECK_CONSTRAINT_VIOLATED':
      return { kind: 'check', constraint: true, loggable: false };
    case 'ER_DATA_TOO_LONG':
      return { kind: 'data_too_long', constraint: true, loggable: false };
    case 'ER_TRUNCATED_WRONG_VALUE':
      return { kind: 'bad_value', constraint: true, loggable: false };
    case 'ECONNREFUSED':
    case 'ETIMEDOUT':
    case 'ENOTFOUND':
    case 'ER_ACCESS_DENIED_ERROR':
      return { kind: 'unavailable', constraint: false, loggable: true };
    case 'ER_LOCK_DEADLOCK':
    case 'ER_LOCK_WAIT_TIMEOUT':
      return { kind: 'deadlock', constraint: false, loggable: true };
    default:
      return { kind: 'unknown', constraint: false, loggable: true };
  }
}
