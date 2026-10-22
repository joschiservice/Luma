import { expect, it } from 'vitest';

import { readModelGatewayConfig } from './model-gateway.js';

const route = {
  adapter: 'vercel',
  model: 'anthropic/claude-sonnet-4.5',
  providers: ['anthropic'],
  zeroDataRetention: true,
};

const authoring = {
  adapter: 'bedrock',
  model: 'eu.anthropic.claude-sonnet-4-5-20250929-v1:0',
  providers: ['bedrock'],
  zeroDataRetention: true,
};

const bedrockEnv = {
  MODEL_GATEWAY_ROUTES: JSON.stringify({ authoring }),
  MODEL_GATEWAY_BEDROCK_REGION: 'eu-central-1',
  MODEL_GATEWAY_BEDROCK_ACCESS_KEY_ID: 'AKIAEXAMPLECONFIG01',
  MODEL_GATEWAY_BEDROCK_SECRET_ACCESS_KEY: 'config/secret+access-key',
};

it('disables model calls by default', () => {
  expect(
    readModelGatewayConfig({ LUMA_REGION: 'EU', LUMA_ENABLED_REGIONS: 'EU' }),
  ).toEqual({
    dataRegion: 'EU',
    routes: {},
    timeoutMs: 30000,
    tenantDailyTokens: 5_000_000,
  });
});

it('reads the daily token budget per tenant', () => {
  expect(
    readModelGatewayConfig({
      LUMA_REGION: 'EU',
      LUMA_ENABLED_REGIONS: 'EU',
      MODEL_TENANT_DAILY_TOKENS: '250000',
    }).tenantDailyTokens,
  ).toBe(250_000);
});

it('loads a provider-independent profile next to a Bedrock authoring route', () => {
  const routes = { reasoning: route, authoring };
  expect(
    readModelGatewayConfig({
      LUMA_REGION: 'EU',
      LUMA_ENABLED_REGIONS: 'EU',
      ...bedrockEnv,
      AI_GATEWAY_API_KEY: 'test',
      MODEL_GATEWAY_ROUTES: JSON.stringify(routes),
    }).routes,
  ).toEqual(routes);
});

it('loads Bedrock credentials for an EU region', () => {
  expect(
    readModelGatewayConfig({
      LUMA_REGION: 'EU',
      LUMA_ENABLED_REGIONS: 'EU',
      ...bedrockEnv,
      MODEL_GATEWAY_BEDROCK_SESSION_TOKEN: 'session/token+value==',
    }),
  ).toEqual({
    dataRegion: 'EU',
    routes: { authoring },
    timeoutMs: 30000,
    tenantDailyTokens: 5_000_000,
    bedrock: {
      region: 'eu-central-1',
      credentials: {
        accessKeyId: 'AKIAEXAMPLECONFIG01',
        secretAccessKey: 'config/secret+access-key',
        sessionToken: 'session/token+value==',
      },
    },
  });
});

it.each([
  [
    'no Bedrock settings',
    {
      MODEL_GATEWAY_BEDROCK_REGION: undefined,
      MODEL_GATEWAY_BEDROCK_ACCESS_KEY_ID: undefined,
      MODEL_GATEWAY_BEDROCK_SECRET_ACCESS_KEY: undefined,
    },
  ],
  ['a missing region', { MODEL_GATEWAY_BEDROCK_REGION: '' }],
  ['a missing access key', { MODEL_GATEWAY_BEDROCK_ACCESS_KEY_ID: undefined }],
  ['a missing secret', { MODEL_GATEWAY_BEDROCK_SECRET_ACCESS_KEY: undefined }],
  ['London', { MODEL_GATEWAY_BEDROCK_REGION: 'eu-west-2' }],
  ['Zurich', { MODEL_GATEWAY_BEDROCK_REGION: 'eu-central-2' }],
  ['a US region', { MODEL_GATEWAY_BEDROCK_REGION: 'us-east-1' }],
  [
    'a malformed access key',
    { MODEL_GATEWAY_BEDROCK_ACCESS_KEY_ID: 'secret value' },
  ],
  [
    'a secret with whitespace',
    { MODEL_GATEWAY_BEDROCK_SECRET_ACCESS_KEY: 'secret value' },
  ],
  [
    'a token with whitespace',
    { MODEL_GATEWAY_BEDROCK_SESSION_TOKEN: 'secret value' },
  ],
])('fails closed for a Bedrock route with %s', (_name, override) => {
  const read = () =>
    readModelGatewayConfig({
      LUMA_REGION: 'EU',
      LUMA_ENABLED_REGIONS: 'EU',
      ...bedrockEnv,
      ...override,
    });
  expect(read).toThrow();
  expect(read).not.toThrow(/secret|AKIA|eu-west-2|eu-central-2|us-east-1/);
});

it('rejects partial Bedrock credentials even without a Bedrock route', () => {
  expect(() =>
    readModelGatewayConfig({
      LUMA_REGION: 'EU',
      LUMA_ENABLED_REGIONS: 'EU',
      MODEL_GATEWAY_BEDROCK_SESSION_TOKEN: 'token',
    }),
  ).toThrow('together');
});

it.each([
  { MODEL_GATEWAY_ROUTES: 'invalid secret' },
  { MODEL_GATEWAY_ROUTES: '[]' },
  { MODEL_GATEWAY_ROUTES: 'null' },
  { MODEL_GATEWAY_ROUTES: JSON.stringify({ reasoning: route }) },
  { MODEL_GATEWAY_TIMEOUT_MS: '0' },
  { MODEL_GATEWAY_TIMEOUT_MS: '120001' },
  { MODEL_GATEWAY_TIMEOUT_MS: 'NaN' },
  { MODEL_TENANT_DAILY_TOKENS: '999' },
  { MODEL_TENANT_DAILY_TOKENS: '1000000001' },
  { MODEL_TENANT_DAILY_TOKENS: 'off' },
])('rejects invalid or partial configuration', (env) => {
  expect(() => readModelGatewayConfig(env)).toThrow();
});

it.each([
  { providers: [] },
  { providers: [''] },
  { model: 'email@example.com' },
  { adapter: 'unknown' },
  { zeroDataRetention: 'false' },
  { endpoint: 'https://unapproved.example' },
])('rejects unsafe route fields: %j', (override) => {
  expect(() =>
    readModelGatewayConfig({
      LUMA_REGION: 'EU',
      LUMA_ENABLED_REGIONS: 'EU',
      AI_GATEWAY_API_KEY: 'test',
      MODEL_GATEWAY_ROUTES: JSON.stringify({
        reasoning: { ...route, ...override },
      }),
    }),
  ).toThrow('Invalid model route');
});
