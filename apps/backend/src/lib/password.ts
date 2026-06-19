import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const KEYLEN = 64;

/** Hash a password with a per-user random salt. Format: `salt:hash` (hex). */
export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const derived = scryptSync(password, salt, KEYLEN).toString('hex');
  return `${salt}:${derived}`;
}

/** Constant-time verify of a password against a stored `salt:hash`. */
export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const hashBuf = Buffer.from(hash, 'hex');
  const testBuf = scryptSync(password, salt, KEYLEN);
  return hashBuf.length === testBuf.length && timingSafeEqual(hashBuf, testBuf);
}
