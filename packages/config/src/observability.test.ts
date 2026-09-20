import { describe, expect, it } from 'vitest';

import { readObservabilityConfig } from './observability.js';

describe('observability configuration', () => {
  it('runs locally without exporters or credentials', () => {
    expect(readObservabilityConfig({})).toEqual({
      environment: 'development',
      release: 'local',
      sampleRate: 1,
    });
  });
  it.each([
    { POSTHOG_API_KEY: 'key' },
    { OBSERVABILITY_ENVIRONMENT: 'customer-email@example.com' },
    { OBSERVABILITY_RELEASE: 'release with spaces' },
    { OBSERVABILITY_SAMPLE_RATE: 'NaN' },
    { OBSERVABILITY_SAMPLE_RATE: '1.1' },
    { OBSERVABILITY_SAMPLE_RATE: '' },
    { OBSERVABILITY_TENANT_HASH_KEY: 'short' },
    { SENTRY_DSN: 'https://abc@o1.ingest.us.sentry.io/1' },
    { LANGFUSE_PUBLIC_KEY: 'public' },
    {
      LANGFUSE_PUBLIC_KEY: 'public',
      LANGFUSE_SECRET_KEY: 'secret',
      LANGFUSE_BASE_URL: 'https://us.cloud.langfuse.com',
    },
    { POSTHOG_API_KEY: 'key', POSTHOG_HOST: 'https://us.i.posthog.com' },
  ])('rejects unsafe or partial settings: %j', (settings) => {
    expect(() => readObservabilityConfig(settings)).toThrow();
  });
  it('accepts EU exporters and production metadata', () => {
    const config = readObservabilityConfig({
      OBSERVABILITY_ENVIRONMENT: 'production',
      OBSERVABILITY_TENANT_HASH_KEY: 'a'.repeat(32),
      OBSERVABILITY_RELEASE: 'abc123',
      OBSERVABILITY_SAMPLE_RATE: '0.2',
      SENTRY_DSN: 'https://abc@o1.ingest.de.sentry.io/1',
      LANGFUSE_PUBLIC_KEY: 'public',
      LANGFUSE_SECRET_KEY: 'secret',
      POSTHOG_API_KEY: 'key',
    });
    expect(config.langfuse?.baseUrl).toBe('https://cloud.langfuse.com');
    expect(config.posthog?.host).toBe('https://eu.i.posthog.com');
    expect(config.sampleRate).toBe(0.2);
  });
});
