import { Router } from 'express';
import { body, validationResult } from 'express-validator';
import { env } from '../lib/env.js';
import { AppError, sendOk } from '../lib/http.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { requireAuth, type AuthedRequest } from '../middleware/auth.js';
import { prisma } from '../lib/prisma.js';
import {
  buildGoogleAuthUrl,
  devLogin,
  handleGoogleCallback,
  loginWithPassword,
  refreshTokens,
  registerUser,
  revokeRefreshToken,
  verifyState,
} from '../services/authService.js';

export const authRouter: Router = Router();

// POST /api/v1/auth/register → create an email/password account.
authRouter.post(
  '/register',
  body('email').isEmail().withMessage('valid email required'),
  body('password').isLength({ min: 8 }).withMessage('password must be at least 8 chars'),
  body('name').optional().isString(),
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw AppError.badRequest('Validation failed', fieldErrors(errors.array()));
    }
    const name = typeof req.body.name === 'string' && req.body.name.trim() ? req.body.name.trim() : null;
    const tokens = await registerUser(req.body.email as string, req.body.password as string, name);
    sendOk(res, tokens, 201);
  }),
);

// POST /api/v1/auth/login → email/password sign in.
authRouter.post(
  '/login',
  body('email').isEmail(),
  body('password').isString().notEmpty(),
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) throw AppError.badRequest('Email and password are required');
    const tokens = await loginWithPassword(req.body.email as string, req.body.password as string);
    sendOk(res, tokens);
  }),
);

// POST /api/v1/auth/dev-login → issue tokens without Google (development only).
authRouter.post(
  '/dev-login',
  body('email').optional().isEmail(),
  asyncHandler(async (req, res) => {
    if (env.NODE_ENV === 'production') {
      throw AppError.forbidden('dev-login is disabled in production');
    }
    const errors = validationResult(req);
    if (!errors.isEmpty()) throw AppError.badRequest('Invalid email');
    const email =
      typeof req.body.email === 'string' && req.body.email.trim()
        ? req.body.email.trim()
        : 'dev@meetscribe.test';
    const name = typeof req.body.name === 'string' ? req.body.name : 'Dev User';
    const tokens = await devLogin(email, name);
    sendOk(res, tokens);
  }),
);

// GET /api/v1/auth/google → redirect to Google consent screen.
authRouter.get(
  '/google',
  asyncHandler(async (req, res) => {
    const codeChallenge =
      typeof req.query.code_challenge === 'string' ? req.query.code_challenge : undefined;
    res.redirect(buildGoogleAuthUrl(codeChallenge));
  }),
);

// GET /api/v1/auth/google/callback → exchange code, issue tokens, deep-link back.
authRouter.get(
  '/google/callback',
  asyncHandler(async (req, res) => {
    const code = typeof req.query.code === 'string' ? req.query.code : undefined;
    const state = typeof req.query.state === 'string' ? req.query.state : undefined;
    if (!code) throw AppError.badRequest('Missing authorization code');
    verifyState(state);

    const { accessToken, refreshToken } = await handleGoogleCallback(code);
    const target = new URL(`${env.FRONTEND_URL}auth/callback`);
    target.searchParams.set('access_token', accessToken);
    target.searchParams.set('refresh_token', refreshToken);
    res.redirect(target.toString());
  }),
);

// POST /api/v1/auth/refresh → rotate tokens.
authRouter.post(
  '/refresh',
  body('refreshToken').isString().notEmpty(),
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) throw AppError.badRequest('refreshToken is required');
    const tokens = await refreshTokens(req.body.refreshToken as string);
    sendOk(res, tokens);
  }),
);

// POST /api/v1/auth/logout → revoke refresh token.
authRouter.post(
  '/logout',
  body('refreshToken').isString().notEmpty(),
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) throw AppError.badRequest('refreshToken is required');
    await revokeRefreshToken(req.body.refreshToken as string);
    sendOk(res, { revoked: true });
  }),
);

// GET /api/v1/auth/me → current user.
authRouter.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { userId } = req as AuthedRequest;
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw AppError.notFound('User not found');
    sendOk(res, {
      id: user.id,
      email: user.email,
      name: user.name,
      avatarUrl: user.avatarUrl,
      createdAt: user.createdAt.toISOString(),
    });
  }),
);

function fieldErrors(
  arr: Array<{ type: string; path?: string; msg: string }>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of arr) {
    if (e.path) out[e.path] = e.msg;
  }
  return out;
}
