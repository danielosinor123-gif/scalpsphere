/**
 * Configuration / fail-fast behaviour.
 *
 * Runs in an isolated process (set via a second `node --test` run in the
 * package script is unnecessary — each file is already its own process) and
 * asserts that the service refuses to start with unsafe or missing config.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = path.resolve(HERE, '..');

/**
 * Runs `scripts/check-env.js` in a HERMETIC child environment.
 *
 * Two isolation measures, both required:
 *  1. The child env is built from a minimal allow-list, so a value exported on
 *     the developer's shell (or by `npm run test:mysql`) cannot leak in.
 *  2. `DOTENV_CONFIG_PATH` points at a file that does not exist, so the
 *     repository's own `.env` is not loaded either. Without this, a developer
 *     with a valid `.env` present would make the "missing JWT_ACCESS_SECRET"
 *     case impossible to test.
 */
function runCheck(overrides = {}, removed = []) {
  const env = {
    SystemRoot: process.env.SystemRoot,
    windir: process.env.windir,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    PATH: process.env.PATH,
    NODE_ENV: 'development',
    DB_DRIVER: 'mysql',
    // A path that will never exist: dotenv then loads nothing.
    DOTENV_CONFIG_PATH: path.join(BACKEND_ROOT, '.env.does-not-exist'),
    ...overrides,
  };
  for (const key of removed) delete env[key];

  try {
    const stdout = execFileSync(process.execPath, [path.join(BACKEND_ROOT, 'scripts/check-env.js')], {
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, stdout, stderr: '' };
  } catch (err) {
    return { status: err.status, stdout: String(err.stdout ?? ''), stderr: String(err.stderr ?? '') };
  }
}

/** A known-valid baseline; each case below overrides one value at a time. */
const VALID = {
  JWT_ACCESS_SECRET: 'a-very-long-secret-value-of-at-least-32-characters',
  CORS_ALLOWED_ORIGINS: 'http://localhost:4000',
};

test('check-env reports valid configuration', () => {
  const res = runCheck(VALID);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /configuration is valid/);
});

test('startup fails when JWT_ACCESS_SECRET is missing', () => {
  const res = runCheck({}, ['JWT_ACCESS_SECRET']);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /JWT_ACCESS_SECRET/);
  assert.match(res.stderr, /configuration is INVALID/);
});

test('startup fails when JWT_ACCESS_SECRET is too short', () => {
  const res = runCheck({ ...VALID, JWT_ACCESS_SECRET: 'short' });
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /too short/);
});

test('production requires an explicit CORS allow-list', () => {
  const res = runCheck({ ...VALID, NODE_ENV: 'production', CORS_ALLOWED_ORIGINS: '' });
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /CORS_ALLOWED_ORIGINS/);
});

test('a wildcard CORS origin is rejected even outside production', () => {
  const res = runCheck({ ...VALID, CORS_ALLOWED_ORIGINS: '*' });
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /must not contain "\*"/);
});

test('the non-durable memory driver is refused outside tests', () => {
  const res = runCheck({ ...VALID, DB_DRIVER: 'memory' });
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /DB_DRIVER=memory/);
});

test('the memory driver is allowed under NODE_ENV=test', () => {
  const res = runCheck({ ...VALID, NODE_ENV: 'test', DB_DRIVER: 'memory' });
  assert.equal(res.status, 0, res.stderr);
});

test('production requires a database password', () => {
  const res = runCheck({
    ...VALID,
    NODE_ENV: 'production',
    DB_PASSWORD: '',
  });
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /DB_PASSWORD/);
});

test('production rejects a weak bcrypt cost factor', () => {
  const res = runCheck({ ...VALID, NODE_ENV: 'production', DB_PASSWORD: 'x', BCRYPT_ROUNDS: '4' });
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /BCRYPT_ROUNDS/);
});

test('SameSite=None requires a Secure cookie', () => {
  const res = runCheck({ ...VALID, COOKIE_SAMESITE: 'none', COOKIE_SECURE: 'false' });
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /COOKIE_SAMESITE=none/);
});

test('an out-of-range port is rejected', () => {
  const res = runCheck({ ...VALID, PORT: '70000' });
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /PORT/);
});
