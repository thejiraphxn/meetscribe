import type { Response } from 'express';
import type { ApiResponse } from '@meetscribe/shared';

/** Application error with an HTTP status + stable error code. */
export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, string>,
  ) {
    super(message);
    this.name = 'AppError';
  }

  static badRequest(message: string, details?: Record<string, string>): AppError {
    return new AppError(400, 'BAD_REQUEST', message, details);
  }
  static unauthorized(message = 'Unauthorized'): AppError {
    return new AppError(401, 'UNAUTHORIZED', message);
  }
  static forbidden(message = 'Forbidden'): AppError {
    return new AppError(403, 'FORBIDDEN', message);
  }
  static notFound(message = 'Not found'): AppError {
    return new AppError(404, 'NOT_FOUND', message);
  }
  static conflict(message: string): AppError {
    return new AppError(409, 'CONFLICT', message);
  }
}

export function sendOk<T>(res: Response, data: T, status = 200): void {
  const body: ApiResponse<T> = { success: true, data };
  res.status(status).json(body);
}

export function sendError(
  res: Response,
  status: number,
  code: string,
  message: string,
  details?: Record<string, string>,
): void {
  const body: ApiResponse<never> = {
    success: false,
    error: { code, message, ...(details ? { details } : {}) },
  };
  res.status(status).json(body);
}
