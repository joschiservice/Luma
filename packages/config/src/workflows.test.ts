import { expect, it } from 'vitest';
import { readWorkflowConfig } from './workflows.js';
const env = {
  WORKFLOW_DATABASE_URL: 'postgresql://worker:fixture@localhost/luma',
  TEMPORAL_DATA_REGION: 'EU',
};
it('defaults the local worker and requires declared EU placement', () => {
  expect(readWorkflowConfig(env).temporal).toMatchObject({
    namespace: 'default',
    taskQueue: 'luma-exceptions-v1',
    tls: false,
  });
  expect(() =>
    readWorkflowConfig({ ...env, TEMPORAL_DATA_REGION: 'US' }),
  ).toThrow('must be EU');
});
it('requires TLS for production and API keys', () => {
  expect(() => readWorkflowConfig({ ...env, NODE_ENV: 'production' })).toThrow(
    'require TLS',
  );
  expect(() =>
    readWorkflowConfig({ ...env, TEMPORAL_API_KEY: 'fixture' }),
  ).toThrow('require TLS');
  expect(
    readWorkflowConfig({
      ...env,
      TEMPORAL_TLS: 'true',
      TEMPORAL_API_KEY: 'fixture',
    }).temporal.apiKey,
  ).toBe('fixture');
});
it('rejects missing database and invalid connection settings', () => {
  expect(() => readWorkflowConfig({})).toThrow('WORKFLOW_DATABASE_URL');
  expect(() =>
    readWorkflowConfig({ ...env, TEMPORAL_TASK_QUEUE: ' ' }),
  ).toThrow('must not be empty');
  expect(() => readWorkflowConfig({ ...env, TEMPORAL_TLS: 'yes' })).toThrow(
    'true or false',
  );
});
