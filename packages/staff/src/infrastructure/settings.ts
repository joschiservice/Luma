import { isIP } from 'node:net';

import { Client } from 'pg';
import { z } from 'zod';

const loopback = (hostname: string) =>
  ['localhost', '127.0.0.1', '[::1]', '::1'].includes(hostname);

function isNarrowProxyAddress(value: string): boolean {
  const [address, prefix, ...extra] = value.split('/');
  if (!address || extra.length || address.includes('%')) return false;
  const version = isIP(address);
  if (!version || address === '0.0.0.0' || address === '::') return false;
  if (prefix === undefined) return true;
  if (!/^(0|[1-9]\d*)$/.test(prefix)) return false;
  const bits = Number(prefix);

  // Explicit ingress ranges may include at most 256 addresses, not whole networks.
  return version === 4 ? bits >= 24 && bits <= 32 : bits >= 120 && bits <= 128;
}

const databaseUrlSchema = z
  .string()
  .url()
  .refine((value) => {
    try {
      const url = new URL(value);

      return (
        ['postgres:', 'postgresql:'].includes(url.protocol) &&
        !!url.hostname &&
        url.pathname.length > 1
      );
    } catch {
      return false;
    }
  }, 'A PostgreSQL URL with an explicit database is required.');
const provisioningSchema = z
  .object({
    email: z
      .string()
      .trim()
      .email()
      .max(320)
      .transform((value) => value.toLowerCase()),
    subject: z.string().trim().min(1).max(255),
    active: z.boolean(),
    permissions: z.array(
      z.enum([
        'staff.directory.read',
        'staff.workspace.inspect',
        'staff.sessions.revoke',
      ]),
    ),
    operator: z.string().trim().min(1).max(200),
    reason: z.string().trim().min(10).max(500),
  })
  .strict();

export type StaffProvisioningInput = z.input<typeof provisioningSchema>;

/** Validates privileged staff enrollment input before connecting to the administrator database. */
export function validateStaffProvisioning(input: unknown) {
  return provisioningSchema.parse(input);
}

/** Validates the separately supplied administrator connection without reading runtime credentials. */
export function validateStaffAdministratorDatabaseUrl(value: string) {
  return databaseUrlSchema.parse(value);
}

/** Validates the driver's effective local destination, including connection-string query overrides. */
export function validateLocalStaffDatabaseUrl(value: string) {
  const validated = databaseUrlSchema.parse(value);
  // Client.host is assigned from connectionParameters.host; constructing a client opens no connection.
  if (!loopback(new Client({ connectionString: validated }).host))
    throw new Error(
      'Local staff access requires an effective loopback database destination.',
    );

  return validated;
}
const settingsSchema = z
  .object({
    databaseUrl: databaseUrlSchema,
    secret: z.string().min(32),
    publicOrigin: z.string().url(),
    mode: z.enum(['local', 'google']),
    host: z.string(),
    port: z.coerce.number<number>().int().min(1).max(65535),
    cookiePrefix: z
      .string()
      .min(1)
      .regex(/^[a-zA-Z0-9_-]+$/),
    environment: z.enum(['development', 'test', 'production']),
    googleClientId: z.string().optional(),
    googleClientSecret: z.string().optional(),
    googleHostedDomain: z.string().optional(),
    trustedProxy: z
      .array(
        z
          .string()
          .refine(
            isNarrowProxyAddress,
            'Trusted proxies must be explicit IP addresses or narrow CIDR ranges.',
          ),
      )
      .max(64)
      .default([]),
  })
  .superRefine((settings, context) => {
    let url: URL;
    let databaseHost: string;
    try {
      url = new URL(settings.publicOrigin);
      databaseHost = new Client({ connectionString: settings.databaseUrl })
        .host;
    } catch {
      context.addIssue({
        code: 'custom',
        message: 'Valid staff origin and database URLs are required.',
      });

      return;
    }
    if (!['http:', 'https:'].includes(url.protocol))
      context.addIssue({
        code: 'custom',
        message: 'Staff origin must use HTTP or HTTPS.',
      });
    if (url.origin !== settings.publicOrigin || url.username || url.password)
      context.addIssue({
        code: 'custom',
        message: 'Staff origin must be an exact origin without credentials.',
      });
    if (
      settings.mode === 'local' &&
      (settings.environment === 'production' ||
        !loopback(url.hostname) ||
        !loopback(settings.host) ||
        !loopback(databaseHost))
    )
      context.addIssue({
        code: 'custom',
        message:
          'Local staff authentication requires a development environment and loopback origin, listener and database.',
      });
    if (
      settings.mode === 'google' &&
      (!settings.googleClientId ||
        !settings.googleClientSecret ||
        !settings.googleHostedDomain ||
        !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(settings.googleHostedDomain))
    )
      context.addIssue({
        code: 'custom',
        message:
          'Google staff authentication requires a client ID, secret and exact hosted domain.',
      });
    if (settings.mode === 'google' && url.protocol !== 'https:')
      context.addIssue({
        code: 'custom',
        message: 'Google staff authentication requires HTTPS.',
      });
    if (
      settings.mode === 'google' &&
      settings.environment === 'production' &&
      !settings.trustedProxy.length
    )
      context.addIssue({
        code: 'custom',
        message:
          'Production staff authentication requires an explicit trusted ingress proxy.',
      });
  });

export type StaffSettings = z.input<typeof settingsSchema>;

/** Reads isolated staff settings and rejects unsafe local or incomplete production configuration. */
export function readStaffSettings(
  env: Record<string, string | undefined> = process.env,
): StaffSettings {
  return settingsSchema.parse({
    databaseUrl: env.STAFF_DATABASE_URL,
    secret: env.STAFF_AUTH_SECRET,
    publicOrigin: env.STAFF_PUBLIC_ORIGIN,
    mode: env.STAFF_AUTH_MODE,
    host: env.STAFF_API_HOST ?? '127.0.0.1',
    port: env.STAFF_API_PORT,
    cookiePrefix: env.STAFF_COOKIE_PREFIX ?? 'luma-staff',
    environment: env.NODE_ENV ?? 'development',
    googleClientId: env.STAFF_GOOGLE_CLIENT_ID,
    googleClientSecret: env.STAFF_GOOGLE_CLIENT_SECRET,
    googleHostedDomain: env.STAFF_GOOGLE_HOSTED_DOMAIN,
    trustedProxy: env.STAFF_TRUSTED_PROXY?.trim()
      ? env.STAFF_TRUSTED_PROXY.split(',').map((value) => value.trim())
      : [],
  });
}

/** Validates settings supplied by composition callers, including tests and local tooling. */
export function validateStaffSettings(settings: StaffSettings): StaffSettings {
  return settingsSchema.parse(settings);
}
