export interface GmailPushConfig {
  /** Pub/Sub topic Gmail publishes mailbox changes to, `projects/<project>/topics/<topic>`. */
  topic: string;
  /** Audience the push subscription puts in its OIDC token. */
  audience: string;
  /** Service account the push subscription signs its OIDC token as. */
  serviceAccount: string;
}

export interface GmailConfig {
  clientId: string;
  clientSecret: string;
  environment: string;
  callbackUrl: string;
  webOrigin: string;
  push?: GmailPushConfig | undefined;
}

const names = [
  'GMAIL_CLIENT_ID',
  'GMAIL_CLIENT_SECRET',
  'GMAIL_APP_ENVIRONMENT',
  'GMAIL_CALLBACK_URL',
  'GMAIL_WEB_ORIGIN',
] as const;

const pushNames = [
  'GMAIL_PUBSUB_TOPIC',
  'GMAIL_PUSH_AUDIENCE',
  'GMAIL_PUSH_SERVICE_ACCOUNT',
] as const;

/**
 * Returns undefined when Gmail is unconfigured; partial or invalid OAuth settings throw an
 * error. Push settings are optional but must be set together, and only with OAuth settings.
 */
export function readGmailConfig(
  env: Readonly<Record<string, string | undefined>>,
): GmailConfig | undefined {
  const anyPush = pushNames.some((name) => env[name]);
  if (!names.some((name) => env[name])) {
    if (anyPush)
      throw new Error('Configure the GMAIL app settings before GMAIL push');

    return undefined;
  }
  if (names.some((name) => !env[name]?.trim()))
    throw new Error('Configure all GMAIL app settings');
  const callback = new URL(env.GMAIL_CALLBACK_URL!);
  const web = new URL(env.GMAIL_WEB_ORIGIN!);
  if (
    callback.protocol !== 'https:' ||
    callback.username ||
    callback.password ||
    callback.search ||
    callback.hash ||
    callback.pathname !== '/api/v1/gmail/callback'
  )
    throw new Error(
      'GMAIL_CALLBACK_URL must be an HTTPS URL ending in /api/v1/gmail/callback',
    );
  if (
    !['https:', 'http:'].includes(web.protocol) ||
    web.origin !== env.GMAIL_WEB_ORIGIN ||
    (env.NODE_ENV === 'production' && web.protocol !== 'https:')
  )
    throw new Error('GMAIL_WEB_ORIGIN must be an exact web origin');
  if (web.origin !== callback.origin)
    throw new Error(
      'GMAIL_WEB_ORIGIN must match the callback origin so the signed-in session is available',
    );
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(env.GMAIL_APP_ENVIRONMENT!))
    throw new Error('GMAIL_APP_ENVIRONMENT is invalid');
  if (!/^[\x21-\x7e]{1,512}$/.test(env.GMAIL_CLIENT_ID!))
    throw new Error('GMAIL_CLIENT_ID is invalid');

  const config: GmailConfig = {
    clientId: env.GMAIL_CLIENT_ID!,
    clientSecret: env.GMAIL_CLIENT_SECRET!,
    environment: env.GMAIL_APP_ENVIRONMENT!,
    callbackUrl: callback.href,
    webOrigin: web.origin,
  };
  if (!anyPush) return config;
  if (pushNames.some((name) => !env[name]?.trim()))
    throw new Error('Configure all GMAIL push settings');
  if (
    !/^projects\/[a-z][a-z0-9-]{4,28}[a-z0-9]\/topics\/[A-Za-z][A-Za-z0-9._~%+-]{2,254}$/.test(
      env.GMAIL_PUBSUB_TOPIC!,
    )
  )
    throw new Error(
      'GMAIL_PUBSUB_TOPIC must be projects/<project>/topics/<topic>',
    );
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(env.GMAIL_PUSH_SERVICE_ACCOUNT!))
    throw new Error('GMAIL_PUSH_SERVICE_ACCOUNT must be an email address');

  return {
    ...config,
    push: {
      topic: env.GMAIL_PUBSUB_TOPIC!,
      audience: env.GMAIL_PUSH_AUDIENCE!,
      serviceAccount: env.GMAIL_PUSH_SERVICE_ACCOUNT!.toLowerCase(),
    },
  };
}
