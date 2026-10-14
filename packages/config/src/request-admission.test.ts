import { describe, expect, it } from 'vitest';

import { readRequestAdmissionConfig } from './request-admission.js';

describe('Shopify request admission configuration', () => {
  it('keeps coordinator credentials server-side and accepts TLS and cluster discovery', () => {
    expect(readRequestAdmissionConfig({})).toBeUndefined();
    expect(
      readRequestAdmissionConfig({
        SHOPIFY_ADMISSION_URL: 'rediss://luma:secret@valkey.example:6379',
        SHOPIFY_ADMISSION_CLUSTER: 'true',
      }),
    ).toEqual({
      url: 'rediss://luma:secret@valkey.example:6379',
      cluster: true,
    });
  });
  it.each([
    'https://example.test',
    'redis://example.test/1',
    'redis://example.test?token=secret',
    'redis://user@example.test',
    'secret',
  ])(
    'rejects an unsupported destination without exposing its value: %s',
    (url) => {
      expect(() =>
        readRequestAdmissionConfig({ SHOPIFY_ADMISSION_URL: url }),
      ).toThrow('SHOPIFY_ADMISSION_URL');
    },
  );
  it('rejects an ambiguous cluster setting', () => {
    expect(() =>
      readRequestAdmissionConfig({ SHOPIFY_ADMISSION_CLUSTER: 'yes' }),
    ).toThrow('must be true or false');
  });
});
