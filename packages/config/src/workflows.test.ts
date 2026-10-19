import { expect, it } from 'vitest';

import { readWorkflowConfig } from './workflows.js';

const env = {
  WORKFLOW_DATABASE_URL: 'postgresql://worker:fixture@localhost/luma',
  TEMPORAL_DATA_REGION: 'AU',
};
const encrypted = {
  TEMPORAL_KMS_KEY_ARN:
    'arn:aws:kms:ap-southeast-2:123456789012:key/11111111-1111-1111-1111-111111111111',
  TEMPORAL_KMS_REGION: 'ap-southeast-2',
  TEMPORAL_KMS_ACCESS_KEY_ID: 'synthetic',
  TEMPORAL_KMS_SECRET_ACCESS_KEY: 'synthetic',
};

it('defaults the local worker to AU and requires matching placement', () => {
  expect(readWorkflowConfig(env).temporal).toMatchObject({
    namespace: 'default',
    taskQueue: 'luma-exceptions-v1',
    tls: false,
    dataRegion: 'AU',
  });
  expect(() =>
    readWorkflowConfig({ ...env, TEMPORAL_DATA_REGION: 'EU' }),
  ).toThrow('must equal');
  expect(
    readWorkflowConfig({
      ...env,
      LUMA_REGION: 'EU',
      LUMA_ENABLED_REGIONS: 'EU',
      TEMPORAL_DATA_REGION: 'EU',
    }).temporal.dataRegion,
  ).toBe('EU');
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

it('trusts a private Temporal CA only over TLS', () => {
  const pem =
    '-----BEGIN CERTIFICATE-----\nZml4dHVyZQ==\n-----END CERTIFICATE-----\n';
  const encoded = Buffer.from(pem).toString('base64');
  expect(
    readWorkflowConfig({
      ...env,
      TEMPORAL_TLS: 'true',
      TEMPORAL_TLS_SERVER_CA: encoded,
    }).temporal.tls,
  ).toEqual({ serverRootCACertificate: new Uint8Array(Buffer.from(pem)) });
  expect(() =>
    readWorkflowConfig({ ...env, TEMPORAL_TLS_SERVER_CA: encoded }),
  ).toThrow('requires TEMPORAL_TLS=true');
  expect(() =>
    readWorkflowConfig({
      ...env,
      TEMPORAL_TLS: 'true',
      TEMPORAL_TLS_SERVER_CA:
        Buffer.from('not a certificate').toString('base64'),
    }),
  ).toThrow('PEM certificate bundle');
});

it('requires inspected remote endpoints and encrypted production payloads', () => {
  const production = {
    ...env,
    NODE_ENV: 'production',
    TEMPORAL_TLS: 'true',
    TEMPORAL_ADDRESS: 'ap-southeast-2.aws.api.temporal.io:7233',
    LUMA_REGIONAL_SERVICE_ENDPOINTS: JSON.stringify({
      AU: { temporal: ['https://ap-southeast-2.aws.api.temporal.io:7233'] },
    }),
  };
  expect(() =>
    readWorkflowConfig({
      ...production,
      LUMA_REGIONAL_SERVICE_ENDPOINTS: '{}',
    }),
  ).toThrow('endpoint is unavailable');
  expect(() => readWorkflowConfig(production)).toThrow('requires KMS');
  expect(
    readWorkflowConfig({ ...production, ...encrypted }).temporal
      .payloadEncryption?.kmsRegion,
  ).toBe('ap-southeast-2');
});

it('rejects incomplete, foreign-region and multi-region KMS keys and unbounded caching', () => {
  expect(() =>
    readWorkflowConfig({ ...env, TEMPORAL_KMS_REGION: 'ap-southeast-2' }),
  ).toThrow('incomplete');
  expect(() =>
    readWorkflowConfig({
      ...env,
      ...encrypted,
      TEMPORAL_KMS_REGION: 'ap-southeast-4',
    }),
  ).toThrow('cell region');
  expect(() =>
    readWorkflowConfig({
      ...env,
      ...encrypted,
      TEMPORAL_KMS_KEY_ARN: encrypted.TEMPORAL_KMS_KEY_ARN.replace(
        'ap-southeast-2',
        'us-east-1',
      ),
    }),
  ).toThrow('single-region');
  expect(() =>
    readWorkflowConfig({
      ...env,
      ...encrypted,
      TEMPORAL_KMS_KEY_ARN: encrypted.TEMPORAL_KMS_KEY_ARN.replace(
        '11111111-1111-1111-1111-111111111111',
        'mrk-11111111111111111111111111111111',
      ),
    }),
  ).toThrow('single-region');
  expect(() =>
    readWorkflowConfig({
      ...env,
      ...encrypted,
      TEMPORAL_KMS_DECRYPTION_KEY_ARNS: encrypted.TEMPORAL_KMS_KEY_ARN.replace(
        'ap-southeast-2',
        'eu-west-1',
      ),
    }),
  ).toThrow('single-region');
  expect(() =>
    readWorkflowConfig({
      ...env,
      ...encrypted,
      TEMPORAL_KMS_CACHE_TTL_MS: '300001',
    }),
  ).toThrow('cache limit');
});

it('rejects missing database and invalid connection settings', () => {
  expect(() => readWorkflowConfig({})).toThrow('WORKFLOW_DATABASE_URL');
  expect(() =>
    readWorkflowConfig({ ...env, TEMPORAL_TASK_QUEUE: ' ' }),
  ).toThrow('must not be empty');
  expect(() => readWorkflowConfig({ ...env, TEMPORAL_TLS: 'yes' })).toThrow(
    'true or false',
  );
  expect(() =>
    readWorkflowConfig({ ...env, TEMPORAL_ADDRESS: 'localhost:7233/payload' }),
  ).toThrow('host and port');
});
