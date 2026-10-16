#!/usr/bin/env node
/**
 * Provision or reset CUSTOMER portal credentials for an EXISTING `users` row.
 *
 *   npm run customer:credentials -- --email demo.person@example.com
 *   npm run customer:credentials -- --email x@example.com --password-env VAR
 *
 * Why this is a CLI and not an endpoint:
 *   The product has no defined customer-registration requirement yet, so adding
 *   a public sign-up route would be inventing a flow. Identity itself lives in
 *   the `users` table the admin panel already manages; this tool only attaches
 *   a bcrypt password to an existing row. Creating the user is an ADMIN action.
 *
 * Password sources, in order: --password-env VAR, CUSTOMER_PASSWORD, prompt.
 * The password is hashed before anything is written and is never logged.
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

async function readPassword() {
  const viaEnv = arg('password-env');
  if (viaEnv) {
    if (!process.env[viaEnv]) throw new Error(`Environment variable ${viaEnv} is not set.`);
    return process.env[viaEnv];
  }
  if (process.env.CUSTOMER_PASSWORD) return process.env.CUSTOMER_PASSWORD;

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const email = arg('email') ?? (await rl.question('Existing users.email: '));
  const first = await rl.question('Password (will not be echoed by your terminal): ');
  const second = await rl.question('Confirm password: ');
  rl.close();
  if (first !== second) throw new Error('Passwords do not match.');
  return JSON.stringify({ email, password: first });
}

async function main() {
  if (env.db.driver !== 'mysql') {
    process.stderr.write(
      `ERROR: this command targets a real database. DB_DRIVER is "${env.db.driver}".\n`,
    );
    process.exit(2);
  }

  let email;
  let password;
  if (process.env.CUSTOMER_PASSWORD || arg('password-env')) {
    email = arg('email');
    password = process.env.CUSTOMER_PASSWORD ?? process.env[arg('password-env')];
    if (!email) throw new Error('--email is required with --password-env/CUSTOMER_PASSWORD.');
  } else {
    const parsed = JSON.parse(await readPassword());
    email = parsed.email;
    password = parsed.password;
  }

  email = String(email).trim().toLowerCase();

  const problems = passwordPolicyErrors(password);
  if (problems.length > 0) {
    process.stderr.write(`\nPASSWORD POLICY\n${problems.map((p) => `  - ${p}`).join('\n')}\n\n`);
    process.exit(4);
  }

  const db = await createDatabase();
  const { userRepo, customerAuthRepo } = db.repositories;

  const user = await userRepo.findByEmail(email);
  if (!user) {
    await db.close();
    process.stderr.write(
      `\nNo users row with email ${email}.\n` +
        'Customer identity must exist in the admin-managed users table first —\n' +
        'this tool only attaches credentials, it does not create accounts.\n',
    );
    process.exit(5);
  }

  const hash = await hashPassword(password);
  const existing = await customerAuthRepo.findByUserId(user.id);
  if (existing) {
    await customerAuthRepo.setPassword(user.id, hash);
  } else {
    await customerAuthRepo.create({ userId: user.id, passwordHash: hash });
  }

  process.stdout.write(
    `\nCustomer portal credentials ${existing ? 'reset' : 'created'} in "${env.db.database}":\n` +
      `  user   ${user.full_name} <${email}>\n` +
      `  ref    ${user.public_ref}\n\n` +
      'The password was hashed before writing and never logged.\n' +
      'Sign in at  POST /api/v1/customer/auth/login\n\n',
  );
  logger.info('customer_credentials_set', { email, was_existing: Boolean(existing) });
  await db.close();
}

main().catch((err) => {
  process.stderr.write(`\nFAILED\n${err.message}\n\n`);
  process.exit(1);
});
