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
  if (!/^\d+$/.test(port) || Number(port) < 0 || Number(port) > 65535) {
    throw new Error('PORT must be an integer between 0 and 65535');
  }
  const host = env.HOST ?? '127.0.0.1';
  if (!host.trim()) throw new Error('HOST must not be empty');
  const logLevel = env.LOG_LEVEL ?? 'info';
  if (!levels.includes(logLevel as LogLevel))
    throw new Error('LOG_LEVEL is invalid');

  return { host, port: Number(port), logLevel: logLevel as LogLevel };
}

export interface IdentityConfig {
  mail?: { apiKey: string; from: string; origin: string };
  databaseUrl: string;
  secret: string;
  baseURL: string;
  trustedOrigins: string[];
  cookiePrefix?: string;
}

/**
 * Reads and validates server-only identity settings; production trusted origins must use
 * HTTPS.
 */
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
  const cookiePrefix = env.BETTER_AUTH_COOKIE_PREFIX;
  if (cookiePrefix !== undefined && !/^[a-zA-Z0-9_-]{1,64}$/.test(cookiePrefix))
    throw new Error(
      'BETTER_AUTH_COOKIE_PREFIX must contain 1–64 letters, numbers, underscores or hyphens',
    );

  let mail: IdentityConfig['mail'];
  if (env.MAIL_RESEND_API_KEY || env.MAIL_FROM || env.MAIL_PUBLIC_ORIGIN) {
    if (!env.MAIL_RESEND_API_KEY || !env.MAIL_FROM || !env.MAIL_PUBLIC_ORIGIN)
      throw new Error(
        'Configure MAIL_RESEND_API_KEY, MAIL_FROM and MAIL_PUBLIC_ORIGIN together',
      );
    const origin = new URL(env.MAIL_PUBLIC_ORIGIN);
    if (
      origin.origin !== env.MAIL_PUBLIC_ORIGIN ||
      !['https:', 'http:'].includes(origin.protocol) ||
      origin.username ||
      origin.password ||
      (env.NODE_ENV === 'production' && origin.protocol !== 'https:')
    )
      throw new Error('MAIL_PUBLIC_ORIGIN must be the public web origin');
    mail = {
      apiKey: env.MAIL_RESEND_API_KEY,
      from: env.MAIL_FROM,
      origin: origin.origin,
    };
  }

  return {
    ...(mail ? { mail } : {}),
    databaseUrl,
    secret,
    baseURL: base.origin,
    trustedOrigins,
    ...(cookiePrefix === undefined ? {} : { cookiePrefix }),
  };
}

export { readObservabilityConfig } from './observability.js';

export { readModelGatewayConfig } from './model-gateway.js';

export type { ModelGatewayConfig } from './model-gateway.js';

export { readWorkflowConfig } from './workflows.js';

export type { WorkflowConfig } from './workflows.js';

export { readConnectionsConfig } from './connections.js';

export type { ConnectionsConfig } from './connections.js';

export { readCommerceSyncConfig } from './sync.js';

export type { CommerceSyncConfig } from './sync.js';
