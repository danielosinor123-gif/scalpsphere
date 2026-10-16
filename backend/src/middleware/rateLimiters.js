/**
 * Rate limiting.
 *
 * In-process store (single instance). When the deployment scales out, run
 * behind a reverse proxy that terminates all traffic (see
 * docs/DEPLOYMENT_HOSTINGER.md) or swap the store for a shared one.
 *
 * Limits are applied to:
 *   - authentication routes (per IP + email)
 *   - write routes (per IP)
 *   - all other API routes (per IP)
 */
import rateLimit from 'express-rate-limit';
import { env } from '../config/env.js';
import { tooManyRequests } from '../lib/ApiError.js';

/**
 * Key generator that always includes the client IP, even when
 * `express-rate-limit` is configured with a validation warning about
 * `trust proxy`. Express resolves `req.ip` from `trust proxy` already.
 */
export function ipKeyGenerator(req) {
  const forwarded = req.headers?.['x-forwarded-for'];
  const viaHeader = Array.isArray(forwarded) ? forwarded[0] : `${forwarded ?? ''}`;
  const candidate = `${viaHeader.split(',')[0].trim()} ${req.ip ?? ''}`.trim();
  return candidate || 'unknown';
}

function keyForIp(req) {
  return ipKeyGenerator(req);
}

function keyForIpAndEmail(req) {
  const email = String(req.body?.email ?? '').toLowerCase().slice(0, 254);
  return `${keyForIp(req)}::${email}`;
}

function base({ windowMs, max, keyGenerator, skipSuccessfulRequests = false }) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator,
    skipSuccessfulRequests,
    // A 429 is always our own ApiError envelope, so the library's body is
    // never emitted — it would not match the documented error contract.
    handler: (req, res, next) => {
      next(
        tooManyRequests('Too many requests. Try again later.', {
          retry_after_seconds: Math.ceil(windowMs / 1000),
        }),
      );
    },
  });
}

export const loginRateLimiter = base({
  windowMs: env.rateLimit.loginWindowMs,
  max: env.rateLimit.loginMax,
  keyGenerator: keyForIpAndEmail,
  // Only failed attempts count, so a routine sign-in is not penalised.
  skipSuccessfulRequests: true,
});

export const writeRateLimiter = base({
  windowMs: env.rateLimit.writeWindowMs,
  max: env.rateLimit.writeMax,
  keyGenerator: keyForIp,
});

export const apiRateLimiter = base({
  windowMs: env.rateLimit.apiWindowMs,
  max: env.rateLimit.apiMax,
  keyGenerator: keyForIp,
});
