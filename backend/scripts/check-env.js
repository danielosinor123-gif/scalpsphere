#!/usr/bin/env node
/**
 * Validate configuration without starting the server.
 *
 *   npm run check
 *
 * Prints every configuration problem at once (or "configuration is valid").
 * Useful in CI before a deploy, and as a fast way to check a `.env`.
 *
 * `src/config/env.js` is imported dynamically so that the EnvError it throws at
 * module-evaluation time can be reported cleanly instead of crashing the
 * process before this script's own try/catch is in scope.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function main() {
  if (!fs.existsSync(path.join(ROOT, '.env'))) {
    process.stdout.write(
      'NOTE: no .env file found. Copy .env.example to .env and fill it in, or\n' +
        '      export the variables in your shell / process manager.\n\n',
    );
  }

  let cfg;
  try {
    const mod = await import('../src/config/env.js');
    cfg = mod.loadEnv();
  } catch (err) {
    process.stderr.write(`\nconfiguration is INVALID\n${err.message}\n\n`);
    process.exit(1);
  }

  process.stdout.write(
    'configuration is valid\n' +
      `  NODE_ENV              ${cfg.nodeEnv}\n` +
      `  DB_DRIVER             ${cfg.db.driver}\n` +
      `  DB target             ${cfg.db.user}@${cfg.db.host}:${cfg.db.port}/${cfg.db.database}\n` +
      `  CORS allowed origins  ${cfg.corsAllowedOrigins.length}\n` +
      `  trust proxy           ${cfg.trustProxy}\n`,
  );
}

main();
