import { expect, it } from 'vitest';
import { readModelGatewayConfig } from './model-gateway.js';
const route = {
  adapter: 'vercel',
  model: 'anthropic/claude-sonnet-4.5',
  providers: ['anthropic'],
  zeroDataRetention: true,
};
it('disables model calls by default', () => {
  expect(readModelGatewayConfig({})).toEqual({ routes: {}, timeoutMs: 30000 });
});
it('loads a provider-independent profile and an explicitly reserved Bedrock route', () => {
  const routes = {
    reasoning: route,
    private: {
      ...route,
      adapter: 'bedrock-eu',
      model: 'eu.anthropic.model',
      providers: ['bedrock'],
    },
  };
  expect(
    readModelGatewayConfig({
      AI_GATEWAY_API_KEY: 'test',
      MODEL_GATEWAY_ROUTES: JSON.stringify(routes),
    }).routes,
  ).toEqual(routes);
});
it.each([
  { MODEL_GATEWAY_ROUTES: 'invalid secret' },
  { MODEL_GATEWAY_ROUTES: '[]' },
  { MODEL_GATEWAY_ROUTES: 'null' },
  { MODEL_GATEWAY_ROUTES: JSON.stringify({ reasoning: route }) },
  { MODEL_GATEWAY_TIMEOUT_MS: '0' },
  { MODEL_GATEWAY_TIMEOUT_MS: '120001' },
  { MODEL_GATEWAY_TIMEOUT_MS: 'NaN' },
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
      AI_GATEWAY_API_KEY: 'test',
      MODEL_GATEWAY_ROUTES: JSON.stringify({
        reasoning: { ...route, ...override },
      }),
    }),
  ).toThrow('Invalid model route');
});
