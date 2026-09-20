export interface ObservabilityConfig {
  environment: 'development' | 'test' | 'staging' | 'production';
  release: string;
  sampleRate: number;
  tenantHashKey?: string;
  sentryDsn?: string;
  langfuse?: { publicKey: string; secretKey: string; baseUrl: string };
  posthog?: { apiKey: string; host: string };
}

/**
 * Reads telemetry settings and validates EU export destinations; enabled exports require a
 * tenant hash key.
 */
export function readObservabilityConfig(
  env: Readonly<Record<string, string | undefined>>,
): ObservabilityConfig {
  const environment = env.OBSERVABILITY_ENVIRONMENT ?? 'development';
  if (!['development', 'test', 'staging', 'production'].includes(environment))
    throw new Error('OBSERVABILITY_ENVIRONMENT is invalid');
  const release = env.OBSERVABILITY_RELEASE ?? 'local';
  if (!/^[a-zA-Z0-9._-]{1,64}$/.test(release))
    throw new Error('OBSERVABILITY_RELEASE must be a release identifier');
  const rate = env.OBSERVABILITY_SAMPLE_RATE ?? '1';
  if (!/^(0(\.\d+)?|1(\.0+)?)$/.test(rate))
    throw new Error('OBSERVABILITY_SAMPLE_RATE must be between 0 and 1');
  const config: ObservabilityConfig = {
    environment: environment as ObservabilityConfig['environment'],
    release,
    sampleRate: Number(rate),
  };
  if (env.OBSERVABILITY_TENANT_HASH_KEY) {
    if (env.OBSERVABILITY_TENANT_HASH_KEY.length < 32)
      throw new Error(
        'OBSERVABILITY_TENANT_HASH_KEY must have at least 32 characters',
      );
    config.tenantHashKey = env.OBSERVABILITY_TENANT_HASH_KEY;
  }
  if (env.SENTRY_DSN) {
    let url: URL;
    try {
      url = new URL(env.SENTRY_DSN);
    } catch {
      throw new Error('SENTRY_DSN is invalid');
    }
    if (
      url.protocol !== 'https:' ||
      !/^o\d+\.ingest\.de\.sentry\.io$/.test(url.hostname) ||
      !/^[a-f0-9]+$/.test(url.username) ||
      url.password ||
      url.port ||
      !/^\/\d+$/.test(url.pathname) ||
      url.search ||
      url.hash
    )
      throw new Error('SENTRY_DSN must use EU Sentry ingestion');
    config.sentryDsn = env.SENTRY_DSN;
  }
  if (env.LANGFUSE_PUBLIC_KEY || env.LANGFUSE_SECRET_KEY) {
    if (!env.LANGFUSE_PUBLIC_KEY || !env.LANGFUSE_SECRET_KEY)
      throw new Error(
        'LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY are both required',
      );
    const baseUrl = env.LANGFUSE_BASE_URL ?? 'https://cloud.langfuse.com';
    if (baseUrl !== 'https://cloud.langfuse.com')
      throw new Error('LANGFUSE_BASE_URL must use EU Langfuse ingestion');
    config.langfuse = {
      publicKey: env.LANGFUSE_PUBLIC_KEY,
      secretKey: env.LANGFUSE_SECRET_KEY,
      baseUrl,
    };
  }
  if (env.POSTHOG_API_KEY) {
    const host = env.POSTHOG_HOST ?? 'https://eu.i.posthog.com';
    if (host !== 'https://eu.i.posthog.com')
      throw new Error('POSTHOG_HOST must use EU PostHog ingestion');
    config.posthog = { apiKey: env.POSTHOG_API_KEY, host };
  }
  if (
    (config.sentryDsn || config.langfuse || config.posthog) &&
    !config.tenantHashKey
  )
    throw new Error(
      'OBSERVABILITY_TENANT_HASH_KEY is required when telemetry exports are enabled',
    );

  return config;
}
