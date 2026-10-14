import { expect, it } from 'vitest';

import { readIdentityConfig } from './index.js';
import { readModelGatewayConfig } from './model-gateway.js';
import { readObservabilityConfig } from './observability.js';
import { assertRegionalServiceEndpoint, readRegionConfig } from './regions.js';

it('defaults production to AU and requires explicit regional activation', () => {
  expect(readRegionConfig({})).toEqual({
    region: 'AU',
    enabledRegions: ['AU'],
  });
  expect(readRegionConfig({ NODE_ENV: 'production' }).region).toBe('AU');
  for (const region of ['EU', 'US', 'APAC']) {
    expect(() =>
      readRegionConfig({
        NODE_ENV: 'production',
        LUMA_REGION: region,
      }),
    ).toThrow();
  }
  expect(
    readRegionConfig({
      NODE_ENV: 'production',
      LUMA_REGION: 'EU',
      LUMA_ENABLED_REGIONS: 'EU',
    }).region,
  ).toBe('EU');
  expect(
    readRegionConfig({ LUMA_REGION: 'EU', LUMA_ENABLED_REGIONS: 'EU,AU' })
      .region,
  ).toBe('EU');
});

it('disables unapproved AU services and never inherits EU ingestion', () => {
  for (const [service, endpoint] of [
    ['posthog', 'https://eu.i.posthog.com'],
    ['langfuse', 'https://cloud.langfuse.com'],
    ['mail', 'https://api.resend.com'],
    ['temporal', 'https://temporal.eu.example.test'],
  ] as const) {
    expect(() => assertRegionalServiceEndpoint({}, service, endpoint)).toThrow(
      'unavailable',
    );
  }
  expect(() =>
    assertRegionalServiceEndpoint(
      {
        LUMA_REGIONAL_SERVICE_ENDPOINTS: JSON.stringify({
          AU: { posthog: ['https://eu.i.posthog.com'] },
        }),
      },
      'posthog',
      'https://eu.i.posthog.com',
    ),
  ).toThrow('unavailable');
  const env = {
    LUMA_REGIONAL_SERVICE_ENDPOINTS: JSON.stringify({
      AU: { posthog: ['https://posthog.sydney.example.test'] },
    }),
  };
  expect(() =>
    assertRegionalServiceEndpoint(
      env,
      'posthog',
      'https://posthog.sydney.example.test',
    ),
  ).not.toThrow();
  expect(() =>
    assertRegionalServiceEndpoint(
      env,
      'posthog',
      'https://posthog.sydney.example.test.evil.test',
    ),
  ).toThrow();
  expect(() =>
    readObservabilityConfig({
      POSTHOG_API_KEY: 'key',
      OBSERVABILITY_TENANT_HASH_KEY: 'a'.repeat(32),
    }),
  ).toThrow('unavailable');
});

it('accepts Sydney Bedrock and rejects foreign processing and Vercel in AU', () => {
  const settings = {
    MODEL_GATEWAY_BEDROCK_REGION: 'ap-southeast-2',
    MODEL_GATEWAY_BEDROCK_ACCESS_KEY_ID: 'AKIAEXAMPLECONFIG01',
    MODEL_GATEWAY_BEDROCK_SECRET_ACCESS_KEY: 'secret',
    MODEL_GATEWAY_ROUTES: JSON.stringify({
      authoring: {
        adapter: 'bedrock',
        model: 'au.anthropic.claude-sonnet-4-5-20250929-v1:0',
        providers: ['bedrock'],
        zeroDataRetention: true,
      },
    }),
  };
  expect(readModelGatewayConfig(settings).dataRegion).toBe('AU');
  expect(() =>
    readModelGatewayConfig({
      ...settings,
      MODEL_GATEWAY_BEDROCK_REGION: 'eu-central-1',
    }),
  ).toThrow('jurisdiction');
  expect(() =>
    readModelGatewayConfig({
      AI_GATEWAY_API_KEY: 'test',
      MODEL_GATEWAY_ROUTES: JSON.stringify({
        public: {
          adapter: 'vercel',
          model: 'openai/gpt-4.1',
          providers: ['openai'],
          zeroDataRetention: true,
        },
      }),
    }),
  ).toThrow('unavailable');
});

it('uses an explicit parent RP domain and rejects sibling or untrusted origins', () => {
  const env = {
    IDENTITY_DATABASE_URL: 'postgresql://localhost/luma',
    BETTER_AUTH_SECRET: 'a'.repeat(32),
    BETTER_AUTH_URL: 'https://au.app.example.test',
    AUTH_PASSKEY_RP_ID: 'app.example.test',
    AUTH_TRUSTED_ORIGINS: 'https://eu.app.example.test',
  };
  expect(readIdentityConfig(env).passkeyRpId).toBe('app.example.test');
  expect(() =>
    readIdentityConfig({ ...env, AUTH_PASSKEY_RP_ID: 'eu.app.example.test' }),
  ).toThrow('RP_ID');
  expect(() =>
    readIdentityConfig({
      ...env,
      AUTH_TRUSTED_ORIGINS: 'https://evilapp.example.test',
    }),
  ).toThrow('RP_ID');
});
