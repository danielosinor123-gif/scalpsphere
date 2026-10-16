#!/usr/bin/env node
/**
 * Apply pending migrations.
 *
 *   npm run migrate
 *   npm run migrate -- --status
 *
 * Migrations need DDL rights, which the runtime application user deliberately
 * does not have (it is granted SELECT/INSERT/UPDATE/DELETE only). By default
 * this script connects as DB_USER/DB_PASSWORD; set DB_MIGRATION_USER and
 * DB_MIGRATION_PASSWORD to use a more-privileged, migrations-only account.
 *
 * In production, pass those two variables on the command line rather than
 * storing them in a file.
 *
 * Exits non-zero with a single, readable message when anything fails.
 */
import { env } from '../src/config/env.js';
import { runMigrations, listMigrationFiles } from '../src/db/migrate.js';
import { createMysqlPool } from '../src/db/mysql/pool.js';

const MIGRATION_DB_CONFIG = {
  ...env.db,
  user: process.env.DB_MIGRATION_USER ?? env.db.user,
  password: process.env.DB_MIGRATION_PASSWORD ?? env.db.password,
};

async function main() {
  const statusOnly = process.argv.includes('--status');

  if (env.db.driver !== 'mysql') {
    console.error(
      'ERROR: migrations only apply to a MySQL database.\n' +
        `       DB_DRIVER is "${env.db.driver}" (NODE_ENV=${env.nodeEnv}).\n` +
        '       Set DB_DRIVER=mysql in your .env before running `npm run migrate`.',
    );
    process.exit(2);
  }

  if (statusOnly) {
    const pool = await createMysqlPool(MIGRATION_DB_CONFIG);
    const conn = await pool.getConnection();
    try {
      const [rows] = await conn
        .query('SELECT filename, applied_at FROM schema_migrations ORDER BY id')
        .catch(() => [[]]);
      console.log('Applied migrations:');
      for (const r of rows) console.log(`  = ${r.filename}  (${r.applied_at})`);
      if (rows.length === 0) console.log('  (none)');
      console.log('\nAvailable migrations:');
      for (const f of listMigrationFiles()) console.log(`  - ${f.filename}`);
    } finally {
      conn.release();
      await pool.end();
    }
    return;
  }

  console.log(
    `Applying migrations to ${MIGRATION_DB_CONFIG.user}@${MIGRATION_DB_CONFIG.host}:${MIGRATION_DB_CONFIG.port}/${MIGRATION_DB_CONFIG.database}`,
  );
  const result = await runMigrations(MIGRATION_DB_CONFIG, { log: (m) => console.log(m) });
  console.log(
    `\nDone. ${result.applied} migration(s) applied, ${result.total - result.applied} already up to date.`,
  );
}

main().catch((err) => {
  console.error(`\nMIGRATION FAILED\n${err.message}\n`);
  process.exit(1);
});
