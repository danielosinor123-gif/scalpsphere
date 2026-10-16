/**
 * Identifiers.
 *
 * Primary keys are opaque UUIDv4 values. Public-facing references
 * (`SS-USR-00001`, `SS-WDR-00001`, `SS-PAY-00001`) are sequential and derived
 * from a database sequence table so they are stable, short, and the same shape
 * as the numeric IDs the supplied admin.html displays.
 */
import crypto from 'node:crypto';

export function uuid() {
  return crypto.randomUUID();
}

export function randomToken(bytes = 48) {
  return crypto.randomBytes(bytes).toString('base64url');
}

/** SHA-256 hex digest — used to store refresh tokens without keeping the raw value. */
export function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/**
 * Constant-time comparison of two hex strings of equal length.
 */
export function safeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  if (bufA.length !== bufB.length || bufA.length === 0) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}
