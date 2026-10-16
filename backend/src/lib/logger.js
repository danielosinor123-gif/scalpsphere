/**
 * Structured logger. Deliberately tiny and dependency free so that log output
 * is predictable and never leaks secrets.
 *
 * Rules:
 *  - Never log request/response bodies, cookies, Authorization headers or
 *    password/token fields. The redaction list below is a hard backstop.
 *  - Errors are logged with their code and a stack in development only.
 */
import { env } from '../config/env.js';

const SENSITIVE_KEYS = new Set([
  'password',
  'password_hash',
  'passwordHash',
  'new_password',
  'newPassword',
  'current_password',
  'currentPassword',
  'token',
  'access_token',
  'accessToken',
  'refresh_token',
  'refreshToken',
  'secret',
  'authorization',
  'cookie',
  'set-cookie',
  'client_secret',
]);

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

function redact(value, depth = 0) {
  if (depth > 6 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (SENSITIVE_KEYS.has(k.toLowerCase())) {
      out[k] = '[REDACTED]';
    } else {
      out[k] = redact(v, depth + 1);
    }
  }
  return out;
}

function write(level, message, fields = {}) {
  if (LEVELS[level] > LEVELS[env.log.level]) return;

  const entry = {
    level,
    time: new Date().toISOString(),
    message,
    ...redact(fields),
  };

  const line =
    env.log.format === 'pretty'
      ? `${entry.time} ${level.toUpperCase().padEnd(5)} ${message}${
          Object.keys(fields).length ? ' ' + JSON.stringify(redact(fields)) : ''
        }`
      : JSON.stringify(entry);

  const stream = level === 'error' ? process.stderr : process.stdout;
  stream.write(line + '\n');
}

export const logger = {
  error: (message, fields) => write('error', message, fields),
  warn: (message, fields) => write('warn', message, fields),
  info: (message, fields) => write('info', message, fields),
  debug: (message, fields) => write('debug', message, fields),
  child: (bindings) => ({
    error: (m, f) => write('error', m, { ...bindings, ...f }),
    warn: (m, f) => write('warn', m, { ...bindings, ...f }),
    info: (m, f) => write('info', m, { ...bindings, ...f }),
    debug: (m, f) => write('debug', m, { ...bindings, ...f }),
  }),
};

/** Attach a request id and log a single access line per completed request. */
export function requestLogger(req, res, next) {
  const started = process.hrtime.bigint();
  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
    write(level, 'http_request', {
      request_id: req.id,
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      duration_ms: Math.round(durationMs * 100) / 100,
      ip: req.ip,
    });
  });
  next();
}
