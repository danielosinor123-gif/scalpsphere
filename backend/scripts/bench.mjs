#!/usr/bin/env node
/**
 * Capacity benchmark for a RUNNING ScalpSphere API.
 *
 *   node scripts/bench.mjs [baseUrl]
 *
 * Default target: http://127.0.0.1:4000/api/v1
 *
 * Measures, with p50/p95/p99 latency and requests/second:
 *   - /health                      (cheapest; one COUNT(*) on audit_log)
 *   - /users?per_page=20           (typical list: list + count + facets)
 *   - /dashboard/summary           (heaviest read: ~8 queries)
 *   - POST /auth/login             (bcrypt-bound; deliberately slow)
 *   - bcrypt cost on this machine   (the real login bottleneck)
 *
 * Read scenarios run at concurrency 1, 10 and 25. Login is capped at 12
 * iterations because bcrypt at the production cost factor takes ~250 ms by
 * design.
 *
 * Uses the local admin account from .env-style setup:
 *   BENCH_EMAIL / BENCH_PASSWORD (defaults: admin@scalpsphere.local)
 */
import crypto from 'node:crypto';

const BASE = (process.argv[2] ?? 'http://127.0.0.1:4000') + '/api/v1';
const EMAIL = process.env.BENCH_EMAIL ?? 'admin@scalpsphere.local';
const PASSWORD = process.env.BENCH_PASSWORD ?? 'Local-Dev!Admin#2026x';

const percentile = (sorted, p) =>
  sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];

const fmt = (ms) => (ms >= 100 ? ms.toFixed(0) : ms.toFixed(1));

async function login() {
  const res = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`login failed: ${res.status}`);
  return (await res.json()).data.access_token;
}

/** Runs `total` requests at the given concurrency against one path. */
async function runScenario(label, path, token, total, concurrency) {
  const timings = [];
  const statusCounts = new Map();
  let next = 0;

  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= total) return;
      const started = performance.now();
      try {
        const res = await fetch(`${BASE}${path}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        await res.arrayBuffer();
        timings.push(performance.now() - started);
        statusCounts.set(res.status, (statusCounts.get(res.status) ?? 0) + 1);
      } catch (err) {
        timings.push(performance.now() - started);
        statusCounts.set(`fetch-error:${err.cause?.code ?? err.message}`, 1);
      }
    }
  }

  const workers = Array.from({ length: concurrency }, worker);
  const t0 = performance.now();
  await Promise.all(workers);
  const wall = (performance.now() - t0) / 1000;

  timings.sort((a, b) => a - b);
  const rps = total / wall;
  const statuses = [...statusCounts.entries()].map(([k, v]) => `${k}x${v}`).join(' ');
  const throttled = (statusCounts.get(429) ?? 0) > 0;

  console.log(
    `  ${label.padEnd(34)} n=${String(total).padStart(4)}  c=${String(concurrency).padStart(3)}` +
      `  ${fmt(rps)} req/s  p50=${fmt(percentile(timings, 50))}ms` +
      `  p95=${fmt(percentile(timings, 95))}ms  p99=${fmt(percentile(timings, 99))}ms`,
  );
  if (throttled) {
    console.log(
      `      THROTTLED — got 429 responses (${statuses}).\n` +
        `      The API rate limiter is doing its job: RATE_LIMIT_API_MAX requests per IP per window.\n` +
        `      Raise it for the benchmark instance, e.g. RATE_LIMIT_API_MAX=1000000, and re-run.`,
    );
  }
  return rps;
}

async function benchLogin() {
  const timings = [];
  const N = 12;
  for (let i = 0; i < N; i++) {
    const started = performance.now();
    const res = await fetch(`${BASE}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    });
    await res.arrayBuffer();
    timings.push(performance.now() - started);
  }
  timings.sort((a, b) => a - b);
  const mean = timings.reduce((a, b) => a + b, 0) / N;
  console.log(
    `  ${'POST /auth/login (bcrypt, serial)'.padEnd(34)} n=${String(N).padStart(4)}  c=  1` +
      `  ${fmt(1000 / mean)} req/s  p50=${fmt(percentile(timings, 50))}ms` +
      `  p95=${fmt(percentile(timings, 95))}ms`,
  );
}

async function benchBcrypt(rounds) {
  const { default: bcrypt } = await import('bcryptjs');
  const N = 5;
  const t0 = performance.now();
  for (let i = 0; i < N; i++) await bcrypt.hash(crypto.randomBytes(18).toString('base64url'), rounds);
  const perOp = (performance.now() - t0) / N;
  console.log(
    `  ${`bcrypt cost ${rounds} (hash, serial)`.padEnd(34)} n=${String(N).padStart(4)}  c=  1` +
      `  ${fmt(1000 / perOp)} /s   ${fmt(perOp)} ms per hash`,
  );
  console.log(
    `  ${'  -> single core login ceiling'.padEnd(34)} ~${fmt(1000 / perOp)} logins/s/core (verify is the same cost)\n`,
  );
}

const health = await fetch(`${BASE}/health`);
const healthData = (await health.json()).data;
console.log(`\nTarget: ${BASE}`);
console.log(`Driver: ${healthData.checks.driver}   uptime: ${healthData.uptime_seconds}s\n`);

const token = await login();
console.log('Measured on this machine:\n');

await runScenario('GET /health', '/health', token, 200, 1);
await runScenario('GET /health', '/health', token, 400, 10);
await runScenario('GET /health', '/health', token, 500, 25);
console.log('');
await runScenario('GET /users?per_page=20', '/users?per_page=20', token, 200, 1);
await runScenario('GET /users?per_page=20', '/users?per_page=20', token, 400, 10);
await runScenario('GET /users?per_page=20', '/users?per_page=20', token, 500, 25);
console.log('');
await runScenario('GET /dashboard/summary', '/dashboard/summary', token, 200, 1);
await runScenario('GET /dashboard/summary', '/dashboard/summary', token, 400, 10);
await runScenario('GET /dashboard/summary', '/dashboard/summary', token, 500, 25);
console.log('');
await benchLogin();
await benchBcrypt(12);
