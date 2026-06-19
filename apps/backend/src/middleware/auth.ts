import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../lib/http.js';
import { verifyAccessToken } from '../lib/jwt.js';

export interface AuthedRequest extends Request {
  userId: string;
  userEmail: string;
}

/**
 * JWT verify middleware. Expects `Authorization: Bearer <accessToken>`.
 * Attaches `userId` / `userEmail` to the request on success.
 */
export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  const header = req.header('authorization');
  if (!header?.startsWith('Bearer ')) {
    throw AppError.unauthorized('Missing bearer token');
  }
  const token = header.slice('Bearer '.length).trim();
  try {
    const payload = verifyAccessToken(token);
    (req as AuthedRequest).userId = payload.sub;
    (req as AuthedRequest).userEmail = payload.email;
    next();
  } catch {
    throw AppError.unauthorized('Invalid or expired token');
  }
}
