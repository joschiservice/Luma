import type { DataRegion } from './regions.js';
import { assertRegionalServiceEndpoint, readRegionConfig } from './regions.js';

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
  region: DataRegion;
  enabledRegions: DataRegion[];
  passkeyRpId: string;
  regionalOrigins: Partial<Record<DataRegion, string>>;
  globalEntryUrl?: string;
  mail?: {
    apiKey: string;
    from: string;
    origin: string;
    /** Signing secret of the Resend webhook that reports delivery, bounces and complaints. */
    webhookSecret?: string;
  };
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
  const cell = readRegionConfig(env);
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
  const passkeyRpId = env.AUTH_PASSKEY_RP_ID ?? base.hostname;
  if (
    !/^[a-z0-9.-]+$/.test(passkeyRpId) ||
    passkeyRpId.startsWith('.') ||
    passkeyRpId.endsWith('.') ||
    !trustedOrigins.every((origin) => {
      const host = new URL(origin).hostname;

      return (
        host === passkeyRpId ||
        (passkeyRpId.includes('.') && host.endsWith(`.${passkeyRpId}`))
      );
    })
  )
    throw new Error(
      'AUTH_PASSKEY_RP_ID must be the hostname or a parent domain of every auth origin',
    );
  let rawOrigins: unknown;
  try {
    rawOrigins = JSON.parse(env.LUMA_REGIONAL_ORIGINS ?? '{}');
  } catch {
    throw new Error(
      'LUMA_REGIONAL_ORIGINS must be a JSON region-to-origin map',
    );
  }
  if (
    !rawOrigins ||
    typeof rawOrigins !== 'object' ||
    Array.isArray(rawOrigins)
  )
    throw new Error('Invalid regional origins');
  const regionalOrigins: Partial<Record<DataRegion, string>> = {
    [cell.region]: base.origin,
  };
  for (const [region, origin] of Object.entries(rawOrigins)) {
    if (!['EU', 'AU', 'US'].includes(region) || typeof origin !== 'string')
      throw new Error('Invalid regional origins');
    const parsed = new URL(origin);
    if (
      parsed.origin !== origin ||
      !['https:', 'http:'].includes(parsed.protocol) ||
      (env.NODE_ENV === 'production' && parsed.protocol !== 'https:')
    )
      throw new Error('Regional origins must be exact secure HTTP origins');
    regionalOrigins[region as DataRegion] = origin;
  }
  if (
    regionalOrigins[cell.region] !== base.origin ||
    cell.enabledRegions.some((region) => !regionalOrigins[region])
  )
    throw new Error(
      'Every enabled region needs an origin and the cell must match BETTER_AUTH_URL',
    );
  const globalEntryUrl = env.LUMA_GLOBAL_ENTRY_URL;
  if (globalEntryUrl) {
    const parsed = new URL(globalEntryUrl);
    if (
      parsed.origin !== globalEntryUrl ||
      parsed.origin === base.origin ||
      !['https:', 'http:'].includes(parsed.protocol) ||
      (env.NODE_ENV === 'production' && parsed.protocol !== 'https:')
    )
      throw new Error('LUMA_GLOBAL_ENTRY_URL must be a separate HTTP origin');
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
    assertRegionalServiceEndpoint(env, 'mail', 'https://api.resend.com');
    const origin = new URL(env.MAIL_PUBLIC_ORIGIN);
    if (
      origin.origin !== env.MAIL_PUBLIC_ORIGIN ||
      !['https:', 'http:'].includes(origin.protocol) ||
      origin.username ||
      origin.password ||
      (env.NODE_ENV === 'production' && origin.protocol !== 'https:')
    )
      throw new Error('MAIL_PUBLIC_ORIGIN must be the public web origin');
    const webhookSecret = env.MAIL_RESEND_WEBHOOK_SECRET;
    if (
      webhookSecret !== undefined &&
      !/^whsec_[A-Za-z0-9+/=]{16,}$/.test(webhookSecret)
    )
      throw new Error(
        'MAIL_RESEND_WEBHOOK_SECRET must be a Resend signing secret',
      );
    mail = {
      apiKey: env.MAIL_RESEND_API_KEY,
      from: env.MAIL_FROM,
      origin: origin.origin,
      ...(webhookSecret ? { webhookSecret } : {}),
    };
  } else if (env.MAIL_RESEND_WEBHOOK_SECRET)
    throw new Error(
      'MAIL_RESEND_WEBHOOK_SECRET needs MAIL_RESEND_API_KEY, MAIL_FROM and MAIL_PUBLIC_ORIGIN',
    );

  return {
    ...(mail ? { mail } : {}),
    ...cell,
    passkeyRpId,
    regionalOrigins,
    ...(globalEntryUrl ? { globalEntryUrl } : {}),
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

export { readRegionConfig } from './regions.js';

export type { DataRegion } from './regions.js';
