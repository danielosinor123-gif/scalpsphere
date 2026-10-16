/**
 * Migration runner.
 *
 * Applies `migrations/*.sql` in filename order, records the checksum of each
 * applied file in `schema_migrations`, and refuses to re-apply or silently
 * skip a file whose contents changed after it was applied.
 *
 * Migrations are applied with `multipleStatements: true` on a dedicated
 * single connection, and are NOT allowed to interpolate user input — they are
 * static files shipped with the application.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = path.resolve(HERE, '../../migrations');

export function listMigrationFiles(dir = MIGRATIONS_DIR) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith('.sql'))
    .sort()
    .map((filename) => ({
      filename,
      path: path.join(dir, filename),
      sql: fs.readFileSync(path.join(dir, filename), 'utf8'),
      checksum: crypto.createHash('sha256').update(
        fs.readFileSync(path.join(dir, filename)),
      ).digest('hex'),
    }));
}

export async function getAppliedMigrations(conn) {
  const [rows] = await conn.query(
    `SELECT table_name AS t
     FROM information_schema.tables
     WHERE table_schema = DATABASE() AND table_name = 'schema_migrations'`,
  );
  if (rows.length === 0) return new Map();
  const [applied] = await conn.query('SELECT filename, checksum FROM schema_migrations');
  return new Map(applied.map((r) => [r.filename, r.checksum]));
}

export async function runMigrations(dbConfig, { log = console.log } = {}) {
  const pool = mysql.createPool({
    host: dbConfig.host,
    port: dbConfig.port,
    user: dbConfig.user,
    password: dbConfig.password,
    database: dbConfig.database,
    charset: dbConfig.charset,
    multipleStatements: true,
    connectTimeout: dbConfig.connectTimeoutMs,
    ssl: dbConfig.ssl ? { minVersion: 'TLSv1.2' } : undefined,
  });

  const conn = await pool.getConnection();
  const applied = new Map();
  try {
    await conn.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
         filename VARCHAR(190) NOT NULL,
         checksum CHAR(64) NOT NULL,
         applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
         UNIQUE KEY uq_schema_migrations_filename (filename)
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
    );
    const [rows] = await conn.query('SELECT filename, checksum FROM schema_migrations');
    for (const r of rows) applied.set(r.filename, r.checksum);
  } finally {
    conn.release();
  }

  const files = listMigrationFiles();
  if (files.length === 0) {
    await pool.end();
    throw new Error(`No .sql files found in ${MIGRATIONS_DIR}`);
  }

  let appliedCount = 0;
  const errors = [];

  for (const file of files) {
    if (applied.has(file.filename)) {
      if (applied.get(file.filename) !== file.checksum) {
        errors.push(
          `Migration ${file.filename} has been modified after it was applied. ` +
            'Restore the original file or add a new migration.',
        );
      }
      log(`  = ${file.filename} (already applied)`);
      continue;
    }

    const conn2 = await pool.getConnection();
    try {
      await conn2.beginTransaction();
      await conn2.query(file.sql);
      await conn2.query(
        `INSERT INTO schema_migrations (filename, checksum) VALUES (?, ?)
         ON DUPLICATE KEY UPDATE checksum = VALUES(checksum)`,
        [file.filename, file.checksum],
      );
      await conn2.commit();
      appliedCount += 1;
      log(`  + ${file.filename} (applied)`);
    } catch (err) {
      await conn2.rollback().catch(() => {});
      errors.push(`Migration ${file.filename} failed: ${err.message}`);
      break;
    } finally {
      conn2.release();
    }
  }

  await pool.end();

  if (errors.length > 0) {
    throw new Error(errors.join('\n'));
  }

  return { applied: appliedCount, total: files.length };
}
