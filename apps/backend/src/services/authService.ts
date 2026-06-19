import jwt from 'jsonwebtoken';
import { prisma } from '../lib/prisma.js';
import { env } from '../lib/env.js';
import { AppError } from '../lib/http.js';
import {
  generateRefreshToken,
  hashToken,
  signAccessToken,
  verifyRefreshToken,
} from '../lib/jwt.js';
import { hashPassword, verifyPassword } from '../lib/password.js';

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo';

const REDIRECT_URI = `${env.BACKEND_URL}/api/v1/auth/google/callback`;

interface GoogleProfile {
  sub: string;
  email: string;
  name?: string;
  picture?: string;
  email_verified?: boolean;
}

/**
 * Build the Google consent URL. `state` is a short-lived signed token carrying
 * the desktop's PKCE code_challenge for CSRF protection / correlation.
 *
 * The backend is a *confidential* client (it holds GOOGLE_CLIENT_SECRET) and
 * performs the code exchange itself, so we do not forward the PKCE challenge to
 * Google — doing so would require the verifier at exchange time, which lives on
 * the desktop. The challenge is round-tripped purely as opaque state.
 */
export function buildGoogleAuthUrl(codeChallenge: string | undefined): string {
  const state = jwt.sign(
    { cc: codeChallenge ?? null, n: cryptoNonce() },
    env.JWT_SECRET,
    { expiresIn: '10m' },
  );
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: 'openid email profile',
    access_type: 'offline',
    prompt: 'consent',
    state,
  });
  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

function cryptoNonce(): string {
  // Lightweight nonce; full randomness handled by crypto in jwt lib usage.
  return Math.abs(Math.floor((Date.now() % 1e9) + Math.random() * 1e9)).toString(36);
}

export function verifyState(state: string | undefined): void {
  if (!state) throw AppError.badRequest('Missing OAuth state');
  try {
    jwt.verify(state, env.JWT_SECRET);
  } catch {
    throw AppError.badRequest('Invalid or expired OAuth state');
  }
}

async function exchangeCodeForProfile(code: string): Promise<GoogleProfile> {
  const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: REDIRECT_URI,
      grant_type: 'authorization_code',
    }),
  });
  if (!tokenRes.ok) {
    throw AppError.unauthorized('Google token exchange failed');
  }
  const tokens = (await tokenRes.json()) as { access_token?: string };
  if (!tokens.access_token) {
    throw AppError.unauthorized('Google did not return an access token');
  }

  const profileRes = await fetch(GOOGLE_USERINFO_URL, {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  if (!profileRes.ok) {
    throw AppError.unauthorized('Failed to fetch Google profile');
  }
  return (await profileRes.json()) as GoogleProfile;
}

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
}

/** Exchange the OAuth code, upsert the user, and issue our own token pair. */
export async function handleGoogleCallback(code: string): Promise<IssuedTokens> {
  const profile = await exchangeCodeForProfile(code);
  if (!profile.email) {
    throw AppError.unauthorized('Google profile missing email');
  }

  const user = await prisma.user.upsert({
    where: { googleId: profile.sub },
    create: {
      googleId: profile.sub,
      email: profile.email,
      name: profile.name ?? null,
      avatarUrl: profile.picture ?? null,
    },
    update: {
      email: profile.email,
      name: profile.name ?? null,
      avatarUrl: profile.picture ?? null,
    },
  });

  return issueTokens({ id: user.id, email: user.email, name: user.name });
}

async function issueTokens(user: {
  id: string;
  email: string;
  name: string | null;
}): Promise<IssuedTokens> {
  const accessToken = signAccessToken({
    sub: user.id,
    email: user.email,
    ...(user.name ? { name: user.name } : {}),
  });
  const { token: refreshToken, expiresAt } = generateRefreshToken();
  await prisma.refreshToken.create({
    data: { token: hashToken(refreshToken), userId: user.id, expiresAt },
  });
  return { accessToken, refreshToken };
}

/** Rotate a refresh token: validate, revoke the old one, issue a fresh pair. */
export async function refreshTokens(refreshToken: string): Promise<IssuedTokens> {
  if (!verifyRefreshToken(refreshToken)) {
    throw AppError.unauthorized('Invalid refresh token');
  }
  const hashed = hashToken(refreshToken);
  const stored = await prisma.refreshToken.findUnique({
    where: { token: hashed },
    include: { user: true },
  });
  if (!stored || stored.expiresAt.getTime() < Date.now()) {
    throw AppError.unauthorized('Refresh token expired or revoked');
  }

  // Rotate: delete the used token, issue a new pair.
  await prisma.refreshToken.delete({ where: { id: stored.id } });
  return issueTokens({
    id: stored.user.id,
    email: stored.user.email,
    name: stored.user.name,
  });
}

export async function revokeRefreshToken(refreshToken: string): Promise<void> {
  const hashed = hashToken(refreshToken);
  await prisma.refreshToken.deleteMany({ where: { token: hashed } });
}

/** Register a new email/password user and issue tokens. */
export async function registerUser(
  email: string,
  password: string,
  name: string | null,
): Promise<IssuedTokens> {
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    throw AppError.conflict('An account with this email already exists');
  }
  const user = await prisma.user.create({
    data: { email, name, passwordHash: hashPassword(password) },
  });
  return issueTokens({ id: user.id, email: user.email, name: user.name });
}

/** Authenticate an email/password user and issue tokens. */
export async function loginWithPassword(
  email: string,
  password: string,
): Promise<IssuedTokens> {
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || !user.passwordHash || !verifyPassword(password, user.passwordHash)) {
    throw AppError.unauthorized('Invalid email or password');
  }
  return issueTokens({ id: user.id, email: user.email, name: user.name });
}

/**
 * Development-only login: upsert a user by email and issue real tokens without
 * going through Google. Gated by NODE_ENV at the route layer.
 */
export async function devLogin(email: string, name: string): Promise<IssuedTokens> {
  const user = await prisma.user.upsert({
    where: { email },
    create: { email, name, googleId: `dev:${email}` },
    update: { name },
  });
  return issueTokens({ id: user.id, email: user.email, name: user.name });
}
