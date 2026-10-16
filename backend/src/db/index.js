/**
 * Database facade.
 *
 * `createDatabase()` selects a driver from configuration and returns the
 * repository contract that the service layer depends on:
 *
 *   { dialect, repositories, transaction(fn), raw(sql, params), close(), path }
 *
 * The repository object is identical for both drivers, so swapping
 * DB_DRIVER=memory ↔ DB_DRIVER=mysql changes nothing above this line.
 */
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { createMysqlPool } from './mysql/pool.js';
import { createMysqlRepositories } from './mysql/repositories.js';
import { createMemoryRepositories } from './memory/repositories.js';

export async function createDatabase(overrides = {}) {
  const driver = overrides.driver ?? env.db.driver;

  if (driver === 'memory') {
    const db = createMemoryRepositories();
    logger.info('database_driver_selected', { driver: 'memory', durable: false });
    return db;
  }

  if (driver === 'mysql') {
    const pool = await createMysqlPool(env.db);
    logger.info('database_driver_selected', {
      driver: 'mysql',
      host: env.db.host,
      port: env.db.port,
      database: env.db.database,
      ssl: env.db.ssl,
    });
    const repositories = createMysqlRepositories(pool);
    return {
      dialect: 'mysql',
      repositories,
      pool,
      raw: (sql, params) => pool.query(sql, params),
      /** Serialisable unit of work: BEGIN → handler → COMMIT / ROLLBACK. */
      transaction: async (handler) => {
        const conn = await pool.getConnection();
        try {
          await conn.beginTransaction();
          const result = await handler(conn);
          await conn.commit();
          return result;
        } catch (err) {
          try {
            await conn.rollback();
          } catch (rollbackErr) {
            logger.error('transaction_rollback_failed', { reason: rollbackErr.message });
          }
          throw err;
        } finally {
          conn.release();
        }
      },
      close: async () => {
        await pool.end();
      },
      truncateAll: async () => {
        const truncate = async () => {
          const conn = await pool.getConnection();
          try {
            await conn.query('SET FOREIGN_KEY_CHECKS = 0');
            const tables = await conn.query(
              `SELECT table_name AS t FROM information_schema.tables
               WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE'`,
            );
            for (const row of tables[0]) {
              if (row.t === 'schema_migrations') continue;
              await conn.query(`DELETE FROM \`${row.t}\``);
            }
            await conn.query('SET FOREIGN_KEY_CHECKS = 1');
          } finally {
            conn.release();
          }
        };
        await truncate();
      },
    };
  }

  throw new Error(`Unsupported DB_DRIVER "${driver}". Expected "mysql" or "memory".`);
}

export { env };
