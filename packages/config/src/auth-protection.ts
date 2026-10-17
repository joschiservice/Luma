import { readValkeyUrl } from './request-admission.js';

export interface AuthProtectionConfig {
  /** Per-client request limits on sign-in, recovery and verification endpoints. */
  rateLimit: {
    enabled: boolean;
    /** Shared Valkey counters; without it each API instance counts on its own. */
    store?: { url: string; cluster: boolean };
  };
  /**
   * Lowercase name of the request header in which the deployment's proxy sets the client
   * address, overwriting any value the client sent. Without it the socket address is used.
   */
  clientIpHeader?: string;
}

/**
 * Reads sign-in abuse protection settings. Rate limiting is on unless `AUTH_RATE_LIMIT=off`,
 * which production refuses. `AUTH_CLIENT_IP_HEADER` must name a single-value header that only
 * the proxy in front of the API can set.
 */
export function readAuthProtectionConfig(
  env: Readonly<Record<string, string | undefined>>,
): AuthProtectionConfig {
  const mode = env.AUTH_RATE_LIMIT ?? 'on';
  if (!['on', 'off'].includes(mode))
    throw new Error('AUTH_RATE_LIMIT must be on or off');
  if (mode === 'off' && env.NODE_ENV === 'production')
    throw new Error('AUTH_RATE_LIMIT cannot be off in production');
  const store = readValkeyUrl(
    env,
    'AUTH_RATE_LIMIT_URL',
    'AUTH_RATE_LIMIT_CLUSTER',
  );
  const header = env.AUTH_CLIENT_IP_HEADER?.trim().toLowerCase();
  if (
    header !== undefined &&
    header !== '' &&
    (!/^[a-z0-9-]{1,64}$/.test(header) || header.startsWith('x-luma-'))
  )
    throw new Error(
      'AUTH_CLIENT_IP_HEADER must be a header name set by your proxy, such as x-real-ip',
    );

  return {
    rateLimit: { enabled: mode === 'on', ...(store ? { store } : {}) },
    ...(header ? { clientIpHeader: header } : {}),
  };
}
