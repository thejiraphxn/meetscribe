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
  GOOGLE_CLIENT_ID: z.string().min(1),
  GOOGLE_CLIENT_SECRET: z.string().min(1),
  BACKEND_URL: z.string().url(),
  FRONTEND_URL: z.string().min(1).default('meetscribe://'),
  PORT: z.coerce.number().int().positive().default(3000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
});

export type Env = z.infer<typeof envSchema>;

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
  return parsed.data;
}

export const env: Env = loadEnv();
