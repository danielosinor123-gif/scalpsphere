/**
 * One-off local setup: creates the dev + test schemas, a least-privilege app
 * user, and writes backend/.env with generated credentials.
 *
 * Connects as root via mysql2 (the same driver the app uses), so no MySQL CLI
 * binary is needed.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';

const BACKEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const rootPassword = process.env.ROOT_DB_PASSWORD ?? 'rootpass';

const dbPassword = crypto.randomBytes(24).toString('base64url');
const migratePassword = crypto.randomBytes(24).toString('base64url');
const jwtSecret = crypto.randomBytes(48).toString('base64url');

const conn = await mysql.createConnection({
  host: '127.0.0.1',
  port: 3306,
  user: 'root',
  password: rootPassword,
  multipleStatements: false,
});

await conn.query("CREATE DATABASE IF NOT EXISTS scalpsphere CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci");
await conn.query("CREATE DATABASE IF NOT EXISTS scalpsphere_test CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci");

// Runtime user: DML only, so a compromised application cannot alter the schema.
await conn.query("DROP USER IF EXISTS 'scalpsphere_app'@'localhost'");
await conn.query("CREATE USER 'scalpsphere_app'@'localhost' IDENTIFIED BY ?", [dbPassword]);
await conn.query("GRANT SELECT, INSERT, UPDATE, DELETE ON scalpsphere.* TO 'scalpsphere_app'@'localhost'");
await conn.query("GRANT SELECT, INSERT, UPDATE, DELETE ON scalpsphere_test.* TO 'scalpsphere_app'@'localhost'");

// Migration user: DDL, used only by `npm run migrate`.
await conn.query("DROP USER IF EXISTS 'scalpsphere_migrate'@'localhost'");
await conn.query("CREATE USER 'scalpsphere_migrate'@'localhost' IDENTIFIED BY ?", [migratePassword]);
await conn.query("GRANT ALL PRIVILEGES ON scalpsphere.* TO 'scalpsphere_migrate'@'localhost'");
await conn.query("GRANT ALL PRIVILEGES ON scalpsphere_test.* TO 'scalpsphere_migrate'@'localhost'");
await conn.query('FLUSH PRIVILEGES');
await conn.end();

// Prove the app user really is least-privilege and can only see its schemas.
const app = await mysql.createConnection({
  host: '127.0.0.1',
  port: 3306,
  user: 'scalpsphere_app',
  password: dbPassword,
});
const [dbs] = await app.query('SHOW DATABASES');
const visible = dbs.map((r) => Object.values(r)[0]).filter((n) => !['information_schema', 'performance_schema', 'sys'].includes(n));
try {
  await app.query('CREATE TABLE scalpsphere.noop (id INT)');
  console.log('WARNING: app user can create tables — privileges are too broad');
} catch {
  console.log('app user is least-privilege (CREATE TABLE refused)');
}
await app.end();
console.log('app user visible databases: ' + visible.join(', '));
const envPath = path.join(BACKEND, '.env');
fs.writeFileSync(envPath, `# ---------------------------------------------------------------------------
# LOCAL DEVELOPMENT - generated automatically by scripts/setup-local-db.mjs
# This file is gitignored and must never be committed.
#
# It points at the MariaDB instance installed as the Windows service
# "MySQLTest" (bind-address=127.0.0.1, loopback only).
#
#   start/stop the database:  net start MySQLTest   /   net stop MySQLTest
#
# Two schemas exist:
#   scalpsphere       <- this file points here (npm run dev)
#   scalpsphere_test  <- throwaway schema for npm run test:mysql / smoke:db
#                        (pass DB_NAME=scalpsphere_test explicitly)
# ---------------------------------------------------------------------------

NODE_ENV=development
PORT=4000
HOST=127.0.0.1
API_ORIGIN=http://127.0.0.1:4000

CORS_ALLOWED_ORIGINS=http://localhost:4000,http://127.0.0.1:4000
TRUST_PROXY=loopback

DB_DRIVER=mysql
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=scalpsphere_app
DB_PASSWORD=${dbPassword}
DB_NAME=scalpsphere
DB_POOL_SIZE=10
DB_SSL=false

# Used ONLY by \`npm run migrate\`. The runtime user above has no DDL rights.
# In production, pass these on the command line instead of storing them.
DB_MIGRATION_USER=scalpsphere_migrate
DB_MIGRATION_PASSWORD=${migratePassword}

JWT_ACCESS_SECRET=${jwtSecret}
JWT_ISSUER=scalpsphere
JWT_AUDIENCE=scalpsphere-admin
JWT_ACCESS_TTL=15m
REFRESH_TOKEN_TTL_DAYS=30
BCRYPT_ROUNDS=12
LOGIN_MAX_ATTEMPTS=8
LOGIN_LOCKOUT_MINUTES=15

COOKIE_SECURE=false
COOKIE_SAMESITE=strict
API_BASE_PATH=/api/v1

LOG_LEVEL=info
LOG_FORMAT=pretty

SEED_ALLOW_IN_PRODUCTION=false
`);

console.log('.env written to ' + envPath);
console.log('credentials were generated randomly and are NOT printed here');
