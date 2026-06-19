import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import type { JwtPayload } from '@meetscribe/shared';
import { env } from './env.js';

const ACCESS_TTL = '15m';
const REFRESH_TTL_DAYS = 30;

export interface AccessClaims {
  sub: string;
  email: string;
  name?: string;
}

export function signAccessToken(claims: AccessClaims): string {
  return jwt.sign(claims, env.JWT_SECRET, { expiresIn: ACCESS_TTL });
}

export function verifyAccessToken(token: string): JwtPayload {
  // jwt.verify throws on invalid/expired; callers translate to 401.
  return jwt.verify(token, env.JWT_SECRET) as JwtPayload;
}

/**
 * Refresh tokens are opaque random strings (not JWTs) so they can be revoked by
 * deleting the DB row. We additionally sign them to bind them to the secret.
 */
export function generateRefreshToken(): { token: string; expiresAt: Date } {
  const raw = crypto.randomBytes(48).toString('hex');
  const token = jwt.sign({ jti: raw }, env.JWT_REFRESH_SECRET, {
    expiresIn: `${REFRESH_TTL_DAYS}d`,
  });
  const expiresAt = new Date(Date.now() + REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000);
  return { token, expiresAt };
}

export function verifyRefreshToken(token: string): boolean {
  try {
    jwt.verify(token, env.JWT_REFRESH_SECRET);
    return true;
  } catch {
    return false;
  }
}

/** Store only a hash of the refresh token at rest. */
export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}
