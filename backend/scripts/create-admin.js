#!/usr/bin/env node
/**
 * Provision an administrator.
 *
 *   npm run admin:create
 *   npm run admin:create -- --email ops@example.com --name "Ops Lead" --role owner
 *   npm run admin:create -- --email ops@example.com --password-env ADMIN_PASSWORD
 *
 * This is the ONLY way an administrator account comes into existence. There is
 * no public registration endpoint and no default admin password anywhere in the
 * codebase.
 *
 * The password is read from, in order of preference:
 *   1. `--password-env VARNAME`  (e.g. ADMIN_PASSWORD from a secret store)
 *   2. the `ADMIN_PASSWORD` environment variable
 *   3. an interactive, non-echoing prompt (no shell history, no process list)
 */
import readline from 'node:readline/promises';
import { env } from '../src/config/env.js';
import { logger } from '../src/lib/logger.js';
import { createDatabase } from '../src/db/index.js';
import { uuid } from '../src/lib/ids.js';
import { hashPassword, passwordPolicyErrors } from '../src/lib/password.js';

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  const next = process.argv[index + 1];
  return next && !next.startsWith('--') ? next : '';
}

function promptHidden(text) {
  // Non-echoing read of a single line.
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    const stdout = process.stdout;
    stdout.write(text);
    stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    stdin.resume();
    let value = '';
    const onData = (chunk) => {
      const ch = String(chunk);
      if (ch === '\r' || ch === '\n' || ch === '\u0004') {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.removeListener('data', onData);
        stdout.write('\n');
        resolve(value);
        return;
      }
      if (ch === '\u0003') {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.removeListener('data', onData);
        stdout.write('\n');
        reject(new Error('Aborted.'));
        return;
      }
      if (ch === '\u007f' || ch === '\b') {
        value = value.slice(0, -1);
        return;
      }
      value += ch;
    };
    stdin.on('data', onData);
  });
}

async function readPassword() {
  const viaEnv = arg('password-env');
  if (viaEnv) {
    if (!process.env[viaEnv]) throw new Error(`Environment variable ${viaEnv} is not set.`);
    return process.env[viaEnv];
  }
  if (process.env.ADMIN_PASSWORD) return process.env.ADMIN_PASSWORD;

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const email = arg('email') ?? (await rl.question('Email: '));
  const name = arg('name') ?? (await rl.question('Full name: '));
  const role = arg('role') ?? (await rl.question('Role (owner|admin|support) [admin]: ') || 'admin');
  const first = await promptHidden('Password (not echoed): ');
  const second = await promptHidden('Confirm password: ');
  rl.close();

  if (first !== second) throw new Error('Passwords do not match.');
  return JSON.stringify({ email, name, role, password: first });
}

async function main() {
  if (env.db.driver !== 'mysql') {
    process.stderr.write(
      'ERROR: administrators can only be provisioned against a real database.\n' +
        `       DB_DRIVER is "${env.db.driver}" (NODE_ENV=${env.nodeEnv}).\n`,
    );
    process.exit(2);
  }

  let input;
  if (process.env.ADMIN_PASSWORD || arg('password-env')) {
    const email = arg('email');
    const name = arg('name');
    const role = arg('role') ?? 'admin';
    if (!email || !name) throw new Error('--email and --name are required with --password-env/ADMIN_PASSWORD.');
    input = { email, name, role, password: process.env.ADMIN_PASSWORD ?? process.env[arg('password-env')] };
  } else {
    const parsed = JSON.parse(await readPassword());
    input = parsed;
  }

  const email = String(input.email).trim().toLowerCase();
  const fullName = String(input.name).trim();
  const role = ['owner', 'admin', 'support'].includes(input.role) ? input.role : 'admin';

  const problems = passwordPolicyErrors(input.password);
  if (problems.length > 0) {
    process.stderr.write(`\nPASSWORD POLICY\n${problems.map((p) => `  - ${p}`).join('\n')}\n\n`);
    process.exit(4);
  }

  const db = await createDatabase();
  const { adminRepo } = db.repositories;

  const existing = await adminRepo.findByEmail(email);
  if (existing) {
    await db.close();
    process.stderr.write(`\nAn administrator with email ${email} already exists.\n`);
    process.exit(5);
  }

  const hash = await hashPassword(input.password);
  await adminRepo.create({ id: uuid(), email, passwordHash: hash, fullName, role, status: 'active' });

  process.stdout.write(
    `\nAdministrator created in "${env.db.database}":\n` +
      `  name   ${fullName}\n` +
      `  email  ${email}\n` +
      `  role   ${role}\n\n` +
      'The password was never written to disk or logged. Sign in at\n' +
      `  POST ${env.apiBasePath}/auth/login\n\n`,
  );
  logger.info('admin_created', { email, role });
  await db.close();
}

main().catch((err) => {
  process.stderr.write(`\nADMIN CREATION FAILED\n${err.message}\n\n`);
  process.exit(1);
});
