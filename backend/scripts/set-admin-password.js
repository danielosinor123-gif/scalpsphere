#!/usr/bin/env node
/**
 * Reset an administrator's password and revoke every session.
 *
 *   npm run admin:set-password -- --email ops@example.com --password-env ADMIN_PASSWORD
 *   npm run admin:set-password            # interactive
 *
 * Never reveals the existing hash. Requires the new password to satisfy the
 * policy and immediately revokes every active session.
 */
import readline from 'node:readline/promises';
import { env } from '../src/config/env.js';
import { logger } from '../src/lib/logger.js';
import { createDatabase } from '../src/db/index.js';
import { hashPassword, passwordPolicyErrors } from '../src/lib/password.js';

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  const next = process.argv[index + 1];
  return next && !next.startsWith('--') ? next : '';
}

async function main() {
  if (env.db.driver !== 'mysql') {
    process.stderr.write(
      'ERROR: this command targets a real database.\n' +
        `       DB_DRIVER is "${env.db.driver}" (NODE_ENV=${env.nodeEnv}).\n`,
    );
    process.exit(2);
  }

  let email = arg('email');
  let password;

  const viaEnv = arg('password-env');
  if (viaEnv) {
    if (!process.env[viaEnv]) throw new Error(`Environment variable ${viaEnv} is not set.`);
    password = process.env[viaEnv];
  } else if (process.env.ADMIN_PASSWORD) {
    password = process.env.ADMIN_PASSWORD;
  }

  if (!email || !password) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    email = email ?? (await rl.question('Administrator email: '));
    if (!password) password = await rl.question('New password: ');
    rl.close();
  }

  const problems = passwordPolicyErrors(password);
  if (problems.length > 0) {
    process.stderr.write(`\nPASSWORD POLICY\n${problems.map((p) => `  - ${p}`).join('\n')}\n\n`);
    process.exit(4);
  }

  const db = await createDatabase();
  const { adminRepo, sessionRepo } = db.repositories;

  const admin = await adminRepo.findByEmail(email);
  if (!admin) {
    await db.close();
    process.stderr.write(`\nNo administrator with email ${email}.\n`);
    process.exit(5);
  }

  const hash = await hashPassword(password);
  await adminRepo.setPassword(admin.id, hash);
  await adminRepo.clearLock(admin.id);
  const revoked = await sessionRepo.revokeForAdmin(admin.id, 'password_reset', new Date());

  process.stdout.write(
    `\nPassword updated for ${email}. ${revoked} session(s) revoked.\n`,
  );
  logger.info('admin_password_reset', { email });
  await db.close();
}

main().catch((err) => {
  process.stderr.write(`\nPASSWORD RESET FAILED\n${err.message}\n\n`);
  process.exit(1);
});
