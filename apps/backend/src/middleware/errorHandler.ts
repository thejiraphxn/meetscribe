import type { NextFunction, Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { AppError, sendError } from '../lib/http.js';

/** Centralised error handler. Must be registered last, after all routes. */
export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction,
): void {
  if (err instanceof AppError) {
    sendError(res, err.status, err.code, err.message, err.details);
    return;
  }

  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2002') {
      sendError(res, 409, 'CONFLICT', 'Unique constraint violation');
      return;
    }
    if (err.code === 'P2025') {
      sendError(res, 404, 'NOT_FOUND', 'Record not found');
      return;
    }
  }

  // eslint-disable-next-line no-console
  console.error('Unhandled error:', err);
  sendError(res, 500, 'INTERNAL', 'Internal server error');
}

/** Wrap an async route handler so rejected promises reach the error handler. */
export function asyncHandler<
  H extends (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
>(handler: H) {
  return (req: Request, res: Response, next: NextFunction): void => {
    handler(req, res, next).catch(next);
  };
}
