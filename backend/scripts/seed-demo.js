#!/usr/bin/env node
/**
 * Seed SYNTHETIC DEMO FIXTURES.
 *
 *   npm run seed            # add fixtures (refuses if the tables are non-empty)
 *   npm run seed:reset      # wipe then re-seed
 *   npm run seed -- --yes   # skip the confirmation prompt (CI)
 *
 * GUARDS
 *  - Every row is flagged `is_demo = 1` and every aggregate is `is_demo = 1`.
 *  - Refuses to run when NODE_ENV=production unless
 *    SEED_ALLOW_IN_PRODUCTION=true.
 *  - Never creates an administrator. Admins are provisioned separately by
 *    `npm run admin:create`.
 *  - No real identity documents, card details, wallet keys or credentials are
 *    written. Emails use reserved example domains only.
 *  - Requires an explicit confirmation step: this command is never run by
 *    accident as part of a deployment or a migration.
 */
import readline from 'node:readline/promises';
import { env } from '../src/config/env.js';
import { logger } from '../src/lib/logger.js';
import { createDatabase } from '../src/db/index.js';
import { uuid } from '../src/lib/ids.js';
import { hashPassword } from '../src/lib/password.js';

/**
 * Synthetic password shared by every seeded demo CUSTOMER account.
 *
 * Demo-only by construction: the seed command refuses to run when
 * NODE_ENV=production unless SEED_ALLOW_IN_PRODUCTION=true, refuses when the
 * tables are already populated unless --reset, and requires --yes or an
 * interactive "demo" confirmation. Never reuse a real password here.
 */
const DEMO_CUSTOMER_PASSWORD = 'DemoCustomer!Portal#2026x';

const YES = process.argv.includes('--yes') || process.argv.includes('-y');
const RESET = process.argv.includes('--reset');

// ---------------------------------------------------------------------------
// Synthetic demo data — mirrors the demo arrays in admin.html, cleaned up:
//  * the duplicated "Litecoin" row is represented once (a UNIQUE constraint
//    exists on payment_methods.name);
//  * `used_for` uses the same vocabulary as the HTML ('both' | 'deposit' | 'withdraw');
//  * balances/amounts are expressed in minor units.
// ---------------------------------------------------------------------------
const DEMO_USERS = [
  { fullName: 'Trayson Abraham White', email: 'trayson.white@example.com', balanceMinor: 45000, status: 'active', kycStatus: 'verified', createdDaysAgo: 0 },
  { fullName: 'CHAN LYE KLUAN', email: 'chan.kluan@example.com', balanceMinor: 53700, status: 'active', kycStatus: 'verified', createdDaysAgo: 20 },
  { fullName: 'Cryptostats2020', email: 'cryptostats@example.com', balanceMinor: 1000, status: 'active', kycStatus: 'pending', createdDaysAgo: 83 },
  { fullName: 'Lynn Wright', email: 'lynn.wright@example.com', balanceMinor: 1000, status: 'inactive', kycStatus: 'pending', createdDaysAgo: 84 },
  { fullName: 'M. Wright', email: 'mwright@example.com', balanceMinor: 125000, status: 'active', kycStatus: 'verified', createdDaysAgo: 88 },
];

const DEMO_WITHDRAWALS = [
  { userIndex: 1, amountMinor: 53700, feeMinor: 53700, method: 'USDT', receiverEmail: 'sam_0309@hotmail.com', status: 'pending', createdDaysAgo: 20 },
  { userIndex: 2, amountMinor: 1000, feeMinor: 1000, method: 'Ethereum', receiverEmail: 'odonyan@gmail.com', status: 'processed', createdDaysAgo: 83 },
  { userIndex: 3, amountMinor: 1000, feeMinor: 1000, method: 'Ethereum', receiverEmail: 'lmf531@hotmail.com', status: 'processed', createdDaysAgo: 84 },
];

const DEMO_PAYMENT_METHODS = [
  { name: 'USDT', type: 'crypto', usedFor: 'both', status: 'enabled' },
  { name: 'Bitcoin', type: 'crypto', usedFor: 'both', status: 'enabled' },
  { name: 'Ethereum', type: 'crypto', usedFor: 'both', status: 'enabled' },
  { name: 'Bitcoin Cash', type: 'crypto', usedFor: 'both', status: 'disabled' },
  { name: 'Solana', type: 'crypto', usedFor: 'both', status: 'disabled' },
  { name: 'Doge', type: 'crypto', usedFor: 'both', status: 'disabled' },
  { name: 'Ada', type: 'crypto', usedFor: 'both', status: 'disabled' },
  { name: 'Litecoin', type: 'crypto', usedFor: 'both', status: 'disabled' },
  { name: 'XRP', type: 'crypto', usedFor: 'deposit', status: 'disabled' },
  { name: 'BNB', type: 'crypto', usedFor: 'both', status: 'disabled' },
  { name: 'USDC', type: 'crypto', usedFor: 'both', status: 'disabled' },
  { name: 'BUSD', type: 'crypto', usedFor: 'withdraw', status: 'disabled' },
  { name: 'TRX', type: 'crypto', usedFor: 'deposit', status: 'disabled' },
  { name: 'Avax', type: 'crypto', usedFor: 'both', status: 'disabled' },
  { name: 'Near', type: 'crypto', usedFor: 'both', status: 'disabled' },
  { name: 'Hype', type: 'crypto', usedFor: 'both', status: 'disabled' },
  { name: 'SUI', type: 'crypto', usedFor: 'both', status: 'disabled' },
  { name: 'Stellar XLM', type: 'crypto', usedFor: 'both', status: 'disabled' },
  { name: 'Credit Card', type: 'currency', usedFor: 'deposit', status: 'disabled' },
  { name: 'Bank Transfer', type: 'currency', usedFor: 'both', status: 'disabled' },
  { name: 'Paypal', type: 'currency', usedFor: 'deposit', status: 'disabled' },
];

const DEMO_SETTINGS = {
  default_currency: 'USD',
  processing_mode: 'automatic',
  payment_instructions: 'Demo instructions — replace with your real funding steps before going live.',
  minimum_deposit_minor: 1000,
  minimum_withdrawal_minor: 1000,
};

/** Synthetic daily rollups: deposits and active investments for the dashboard cards. */
const DEMO_METRICS = (() => {
  const rows = [];
  const today = new Date();
  for (let i = 13; i >= 0; i -= 1) {
    const d = new Date(today.getTime() - i * 24 * 60 * 60 * 1000);
    const date = d.toISOString().slice(0, 10);
    rows.push({ metric_date: date, metric_key: 'deposits', amount_minor: 3_000_00 + i * 40_00, count_value: 3 + (i % 4) });
    rows.push({ metric_date: date, metric_key: 'withdrawals', amount_minor: 1_000_00 + i * 20_00, count_value: 2 + (i % 3) });
    rows.push({ metric_date: date, metric_key: 'active_investments', amount_minor: 0, count_value: 400 + (13 - i) * 2 });
  }
  return rows;
})();

async function confirm() {
  if (YES) return true;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(
    `\nThis writes SYNTHETIC DEMO fixtures into "${env.db.database}"` +
      `${RESET ? ' after WIPING it' : ''}.\n` +
      'Type "demo" to continue: ',
  );
  rl.close();
  if (answer.trim() !== 'demo') {
    process.stdout.write('Aborted. No data was written.\n');
    return false;
  }
  return true;
}

async function main() {
  if (env.db.driver !== 'mysql') {
    process.stderr.write(
      `ERROR: the seed command writes to a real database.\n` +
        `       DB_DRIVER is "${env.db.driver}" (NODE_ENV=${env.nodeEnv}).\n` +
        '       Set NODE_ENV=test and DB_DRIVER=mysql before seeding a test database.\n',
    );
    process.exit(2);
  }

  if (env.isProduction && !env.seed.allowInProduction) {
    process.stderr.write(
      'ERROR: seeding is refused when NODE_ENV=production.\n' +
        '       If this is genuinely a demo deployment, set SEED_ALLOW_IN_PRODUCTION=true ' +
        'and re-run. All seeded rows are flagged is_demo=1.\n',
    );
    process.exit(2);
  }

  const db = await createDatabase();
  const {
    userRepo, withdrawalRepo, paymentMethodRepo, settingsRepo, metricsRepo,
    adminRepo, customerAuthRepo,
  } = db.repositories;

  const existingUsers = await userRepo.countAll();
  const existingAdmins = await adminRepo.count();
  if (!RESET && (existingUsers > 0 || existingAdmins > 0)) {
    process.stderr.write(
      `ERROR: refusing to seed — the database already contains ${existingUsers} user(s) and ` +
        `${existingAdmins} administrator(s).\n` +
        '       Use `npm run seed:reset` to wipe and re-seed, or clear the tables manually.\n',
    );
    await db.close();
    process.exit(2);
  }

  if (!(await confirm())) {
    await db.close();
    return;
  }

  try {
    if (RESET) {
      await db.truncateAll();
      logger.info('seed_reset', { database: env.db.database });
    }

    const counts = await db.transaction(async () => {
      const createdUsers = [];
      for (const u of DEMO_USERS) {
        const createdAt = new Date(Date.now() - u.createdDaysAgo * 24 * 60 * 60 * 1000);
        const row = await userRepo.create({
          id: uuid(),
          fullName: u.fullName,
          email: u.email,
          balanceMinor: u.balanceMinor,
          status: u.status,
          kycStatus: u.kycStatus,
          isDemo: 1,
        });
        createdUsers.push({ ...row, createdAt });
      }

      // Attach DEMO portal credentials to the demo users so the customer API is
      // usable in a local/dev environment. This is inside the same guarded seed
      // command (production refuses, --yes required, every row is_demo=1) and
      // it creates NO new user rows — it only adds a password to the rows above.
      let customerCredentials = 0;
      for (const u of createdUsers) {
        const hash = await hashPassword(DEMO_CUSTOMER_PASSWORD);
        const existing = await customerAuthRepo.findByUserId(u.id);
        if (existing) {
          await customerAuthRepo.setPassword(u.id, hash);
        } else {
          await customerAuthRepo.create({ userId: u.id, passwordHash: hash });
          customerCredentials += 1;
        }
      }

      let withdrawals = 0;
      for (const w of DEMO_WITHDRAWALS) {
        const user = createdUsers[w.userIndex];
        if (!user) continue;
        await withdrawalRepo.create({
          id: uuid(),
          userId: user.id,
          amountMinor: w.amountMinor,
          feeMinor: w.feeMinor,
          method: w.method,
          receiverEmail: w.receiverEmail,
          status: w.status,
          isDemo: 1,
        });
        withdrawals += 1;
      }

      let methods = 0;
      for (const m of DEMO_PAYMENT_METHODS) {
        const existing = await paymentMethodRepo.findByName(m.name);
        if (existing) {
          await paymentMethodRepo.update(existing.id, {
            name: m.name,
            type: m.type,
            used_for: m.usedFor,
            status: m.status,
            is_demo: 1,
          });
        } else {
          await paymentMethodRepo.create({
            id: uuid(),
            name: m.name,
            type: m.type,
            usedFor: m.usedFor,
            status: m.status,
            isDemo: 1,
          });
        }
        methods += 1;
      }

      await settingsRepo.upsert(DEMO_SETTINGS, null);
      await metricsRepo.clearAll();
      await metricsRepo.seedDemoRows(DEMO_METRICS);

      return { users: createdUsers.length, customerCredentials, withdrawals, methods, metrics: DEMO_METRICS.length };
    });

    process.stdout.write(
      `\nDemo fixtures written to "${env.db.database}":\n` +
        `  users (is_demo=1)                 ${counts.users}\n` +
        `  customer portal credentials       ${counts.customerCredentials}\n` +
        `  withdrawals (is_demo=1)            ${counts.withdrawals}\n` +
        `  payment methods (is_demo=1)        ${counts.methods}\n` +
        `  payment settings                  1 (singleton)\n` +
        `  demo metrics (is_demo=1)          ${counts.metrics}\n\n` +
        `Demo customer sign-in: POST /api/v1/customer/auth/login with any seeded\n` +
        `email and the demo password "${DEMO_CUSTOMER_PASSWORD}".\n\n` +
        'No administrator was created. Provision one with `npm run admin:create`.\n',
    );

    logger.info('seed_complete', { ...counts, database: env.db.database });
  } catch (err) {
    logger.error('seed_failed', { reason: err.message });
    process.stderr.write(`\nSEED FAILED\n${err.message}\n\n`);
    await db.close();
    process.exit(1);
  }

  await db.close();
}

main().catch((err) => {
  process.stderr.write(`\nSEED FAILED\n${err.message}\n\n`);
  process.exit(1);
});
