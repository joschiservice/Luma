const levels = [
  'fatal',
  'error',
  'warn',
  'info',
  'debug',
  'trace',
  'silent',
] as const;
type LogLevel = (typeof levels)[number];

export interface ApiConfig {
  host: string;
  port: number;
  logLevel: LogLevel;
}

/** Read once at startup; never expose the server environment to browser code. */
export function readApiConfig(
  env: Readonly<Record<string, string | undefined>>,
): ApiConfig {
  const port = env.PORT ?? '3001';
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }
  const host = env.HOST ?? '127.0.0.1';
  if (!host.trim()) throw new Error('HOST must not be empty');
  const logLevel = env.LOG_LEVEL ?? 'info';
  if (!levels.includes(logLevel as LogLevel))
    throw new Error('LOG_LEVEL is invalid');
  return { host, port: Number(port), logLevel: logLevel as LogLevel };
}

export interface IdentityConfig {
  databaseUrl: string;
  secret: string;
  baseURL: string;
  trustedOrigins: string[];
}
export function readIdentityConfig(
  env: Readonly<Record<string, string | undefined>>,
): IdentityConfig {
  const databaseUrl = env.IDENTITY_DATABASE_URL;
  if (
    !databaseUrl ||
    !['postgres:', 'postgresql:'].includes(new URL(databaseUrl).protocol)
  )
    throw new Error('IDENTITY_DATABASE_URL must be a PostgreSQL URL');
  const secret = env.BETTER_AUTH_SECRET;
  if (!secret || secret.length < 32)
    throw new Error('BETTER_AUTH_SECRET must contain at least 32 characters');
  const rawURL = env.BETTER_AUTH_URL;
  if (!rawURL) throw new Error('BETTER_AUTH_URL is required');
  const base = new URL(rawURL);
  if (
    !['http:', 'https:'].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    base.pathname !== '/'
  )
    throw new Error('BETTER_AUTH_URL must be an HTTP origin');
  const trustedOrigins = [
    ...new Set([
      base.origin,
      ...(env.AUTH_TRUSTED_ORIGINS?.split(',')
        .map((value) => value.trim())
        .filter(Boolean) ?? []),
    ]),
  ];
  for (const origin of trustedOrigins) {
    const parsed = new URL(origin);
    if (
      !['http:', 'https:'].includes(parsed.protocol) ||
      parsed.origin !== origin ||
      parsed.hostname.includes('*')
    )
      throw new Error('AUTH_TRUSTED_ORIGINS must contain exact HTTP origins');
    if (env.NODE_ENV === 'production' && parsed.protocol !== 'https:')
      throw new Error('Production auth origins must use HTTPS');
  }
  return { databaseUrl, secret, baseURL: base.origin, trustedOrigins };
}

export { readObservabilityConfig } from './observability.js';
export type { ObservabilityConfig } from './observability.js';
export { readModelGatewayConfig } from './model-gateway.js';
export type { ModelGatewayConfig } from './model-gateway.js';
