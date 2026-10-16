#!/usr/bin/env node
/**
 * Revoke every active session for an administrator.
 *
 *   npm run admin:revoke-sessions -- --email ops@example.com --reason "device lost"
 */
import { env } from '../src/config/env.js';
import { createDatabase } from '../src/db/index.js';

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  const next = process.argv[index + 1];
  return next && !next.startsWith('--') ? next : '';
}

async function main() {
  if (env.db.driver !== 'mysql') {
    process.stderr.write(
      `ERROR: this command targets a real database. DB_DRIVER="${env.db.driver}".\n`,
    );
    process.exit(2);
  }

  const email = arg('email');
  if (!email) {
    process.stderr.write('Usage: node scripts/revoke-sessions.js --email <email>\n');
    process.exit(2);
  }

  const db = await createDatabase();
  const { adminRepo, sessionRepo } = db.repositories;
  const admin = await adminRepo.findByEmail(email);
  if (!admin) {
    await db.close();
    process.stderr.write(`\nNo administrator with email ${email}.\n`);
    process.exit(5);
  }
  const n = await sessionRepo.revokeForAdmin(admin.id, arg('reason') ?? 'manual', new Date());
  process.stdout.write(`Revoked ${n} session(s) for ${email}.\n`);
  await db.close();
}

main().catch((err) => {
  process.stderr.write(`\nFAILED\n${err.message}\n\n`);
  process.exit(1);
});
