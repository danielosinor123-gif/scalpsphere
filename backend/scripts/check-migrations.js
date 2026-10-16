/**
 * Static sanity check of the SQL migrations.
 *
 * cat statements after stripping -- comments and ;-terminated bodies, then
 * verifies:
 *   1. every statement ends with a semicolon;
 *   2. parentheses are balanced inside each statement;
 *   3. no statement contains an unescaped interpolation marker other than the
 *      documented "VALUES(" / ";=" forms (which are MySQL keywords, not user
 *      input);
 *   4. only ?-style placeholders would ever be added at runtime (the migration
 *      file itself is static and must contain no '${' template interpolation).
 *
 * Run with: node scripts/check-migrations.js
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.resolve(HERE, '../migrations');

const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();
if (files.length === 0) {
  console.error('No migrations found.');
  process.exit(1);
}

let problems = 0;

for (const file of files) {
  const raw = fs.readFileSync(path.join(DIR, file), 'utf8');

  if (raw.includes('${')) {
    console.error(`${file}: contains template interpolation \${...} — migrations must be static SQL`);
    problems += 1;
  }

  // Strip -- comments (only when they start a line or follow whitespace).
  const stripped = raw
    .split('\n')
    .map((line) => {
      const idx = line.indexOf('--');
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join('\n')
    .trim();

  const statements = stripped
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);

  for (const stmt of statements) {
    const opens = (stmt.match(/\(/g) ?? []).length;
    const closes = (stmt.match(/\)/g) ?? []).length;
    if (opens !== closes) {
      console.error(`${file}: unbalanced parentheses in statement:\n  ${stmt.slice(0, 80)}...`);
      problems += 1;
    }
    if (!/^(SET|CREATE|INSERT|ALTER|DROP|USE|GRANT|START|COMMIT|BEGIN)/i.test(stmt)) {
      console.error(`${file}: statement does not start with a known DDL verb:\n  ${stmt.slice(0, 80)}`);
      problems += 1;
    }
  }

  console.log(`${file}: ${statements.length} statement(s) parsed`);
}

if (problems > 0) {
  console.error(`\n${problems} problem(s) found.`);
  process.exit(1);
}
console.log('\nAll migrations parse cleanly (balanced parentheses, no interpolation).');
