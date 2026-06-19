import { existsSync } from 'node:fs';
import { z } from 'zod';

// Load a local .env if present. In production (Render) there is no .env file —
// real environment variables are injected — so this is a no-op there.
if (existsSync('.env')) {
  process.loadEnvFile('.env');
}

/**
 * Validate all environment variables at startup. A malformed env aborts the
 * process with a readable error rather than failing deep inside a request.
 */
const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 chars'),
  JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be at least 32 chars'),
  // Optional — only needed for Google sign-in. Email/password works without it.
  GOOGLE_CLIENT_ID: z.string().default(''),
  GOOGLE_CLIENT_SECRET: z.string().default(''),
  // Public URL of this service. Optional: falls back to Render's auto-injected
  // RENDER_EXTERNAL_URL, then to localhost — so the blueprint needs no manual URL.
  BACKEND_URL: z.string().url().optional(),
  RENDER_EXTERNAL_URL: z.string().url().optional(),
  FRONTEND_URL: z.string().min(1).default('meetscribe://'),
  PORT: z.coerce.number().int().positive().default(3000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
});

type RawEnv = z.infer<typeof envSchema>;

export type Env = Omit<RawEnv, 'BACKEND_URL' | 'RENDER_EXTERNAL_URL'> & {
  /** Resolved public base URL of this backend (never undefined). */
  BACKEND_URL: string;
  /** True when Google OAuth credentials are configured. */
  googleEnabled: boolean;
};

function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    // eslint-disable-next-line no-console
    console.error(`Invalid environment configuration:\n${issues}`);
    process.exit(1);
  }
  const d = parsed.data;
  const backendUrl =
    d.BACKEND_URL || d.RENDER_EXTERNAL_URL || `http://localhost:${d.PORT}`;
  return {
    ...d,
    BACKEND_URL: backendUrl,
    googleEnabled: Boolean(d.GOOGLE_CLIENT_ID && d.GOOGLE_CLIENT_SECRET),
  };
}

export const env: Env = loadEnv();
