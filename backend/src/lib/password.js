/**
 * Password hashing.
 *
 * bcrypt with a configurable cost factor (default 12). bcryptjs is a pure-JS
 * implementation, chosen so the service builds and runs identically on any host
 * without a native toolchain. Hashes are single-round bcrypt digests and are
 * safe to store directly in `admins.password_hash`.
 */
import bcrypt from 'bcryptjs';
import { env } from '../config/env.js';

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

export async function hashPassword(plain) {
  return bcrypt.hash(plain, env.auth.bcryptRounds);
}

export async function verifyPassword(plain, hash) {
  if (typeof plain !== 'string' || typeof hash !== 'string') return false;
  return bcrypt.compare(plain, hash);
}

/** Cheap policy check used by the CLI provisioning script. */
export function passwordPolicyErrors(plain) {
  const errors = [];
  if (typeof plain !== 'string' || plain.length < PASSWORD_MIN_LENGTH) {
    errors.push(`Password must be at least ${PASSWORD_MIN_LENGTH} characters.`);
  }
  if (typeof plain === 'string' && plain.length > PASSWORD_MAX_LENGTH) {
    errors.push(`Password must be at most ${PASSWORD_MAX_LENGTH} characters.`);
  }
  if (typeof plain === 'string') {
    if (!/[a-z]/.test(plain)) errors.push('Password must contain a lowercase letter.');
    if (!/[A-Z]/.test(plain)) errors.push('Password must contain an uppercase letter.');
    if (!/[0-9]/.test(plain)) errors.push('Password must contain a number.');
    if (!/[^A-Za-z0-9]/.test(plain)) errors.push('Password must contain a symbol.');
  }
  return errors;
}
