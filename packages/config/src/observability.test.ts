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
    { POSTHOG_SECRET_KEY: 'phs_secret' },
    {
      OBSERVABILITY_TENANT_HASH_KEY: 'a'.repeat(32),
      POSTHOG_API_KEY: 'phc_project',
      POSTHOG_SECRET_KEY: 'phc_project',
    },
    { FEATURE_FLAG_OVERRIDES: 'observability-test' },
    { FEATURE_FLAG_OVERRIDES: 'observability-test=yes' },
    { FEATURE_FLAG_OVERRIDES: 'Customer Email=true' },
    {
      FEATURE_FLAG_OVERRIDES:
        'observability-test=true,observability-test=false',
    },
    { FEATURE_FLAG_OVERRIDES: 'observability-test=true=false' },
    {
      OBSERVABILITY_ENVIRONMENT: 'production',
      FEATURE_FLAG_OVERRIDES: 'observability-test=true',
    },
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
      POSTHOG_SECRET_KEY: 'phs_secret',
    });
    expect(config.langfuse?.baseUrl).toBe('https://cloud.langfuse.com');
    expect(config.posthog).toEqual({
      apiKey: 'key',
      host: 'https://eu.i.posthog.com',
      secretKey: 'phs_secret',
    });
    expect(config.sampleRate).toBe(0.2);
  });
  it('reads development flag overrides, also in local diagnostics', () => {
    expect(
      readObservabilityConfig({
        LUMA_LOCAL_OTLP_ENDPOINT: 'http://127.0.0.1:4318',
        FEATURE_FLAG_OVERRIDES: ' observability-test=true, constructor=false ',
      }).featureFlagOverrides,
    ).toEqual({ 'observability-test': true, constructor: false });
  });
});

it('local mode ignores hosted credentials and uses only loopback endpoints', () => {
  expect(
    readObservabilityConfig({
      LUMA_LOCAL_OTLP_ENDPOINT: 'http://127.0.0.1:4318',
      LUMA_LOCAL_PROFILES_ENDPOINT: 'http://localhost:4040/',
      SENTRY_DSN: 'invalid',
      POSTHOG_API_KEY: 'secret',
      LANGFUSE_PUBLIC_KEY: 'partial',
    }),
  ).toEqual({
    environment: 'development',
    release: 'local',
    sampleRate: 1,
    local: {
      endpoint: 'http://127.0.0.1:4318',
      profilesEndpoint: 'http://localhost:4040',
    },
  });
});

it.each([
  { LUMA_LOCAL_OTLP_ENDPOINT: 'https://example.com' },
  { LUMA_LOCAL_OTLP_ENDPOINT: 'http://127.0.0.1:4318/v1/traces' },
  { LUMA_LOCAL_OTLP_ENDPOINT: 'http://secret@localhost:4318' },
  { LUMA_LOCAL_OTLP_ENDPOINT: 'http://localhost:4318?secret=value' },
  {
    LUMA_LOCAL_OTLP_ENDPOINT: 'http://localhost:4318',
    OBSERVABILITY_ENVIRONMENT: 'production',
  },
  { LUMA_LOCAL_PROFILES_ENDPOINT: 'http://localhost:4040' },
])('rejects invalid local telemetry settings: %j', (settings) => {
  expect(() => readObservabilityConfig(settings)).toThrow();
});
