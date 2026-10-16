/**
 * Per-request context: correlated request id, client IP and user agent.
 *
 * The IP is only trusted when `TRUST_PROXY` is configured correctly, otherwise
 * rate limiting would be bypassable by spoofing X-Forwarded-For.
 */
import { randomUUID } from 'node:crypto';

const HEADER_IP_CANDIDATES = ['cf-connecting-ip', 'x-real-ip', 'x-forwarded-for'];

export function requestContext(req, res, next) {
  req.id = randomUUID();
  res.setHeader('X-Request-Id', req.id);

  const candidates = [
    req.ip,
    ...HEADER_IP_CANDIDATES.map((h) => firstHeaderValue(req.headers[h])),
  ].filter(Boolean);

  req.clientIp = candidates[0] ?? null;
  req.userAgent = firstHeaderValue(req.headers['user-agent']) ?? null;

  next();
}

function firstHeaderValue(value) {
  if (Array.isArray(value)) return value[0];
  if (typeof value !== 'string') return undefined;
  return value.split(',')[0].trim() || undefined;
}
