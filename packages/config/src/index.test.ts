import { describe, expect, it } from 'vitest';
import { readApiConfig } from './index.js';

describe('readApiConfig', () => {
  it('provides local defaults without requiring secrets', () => {
    expect(readApiConfig({})).toEqual({
      host: '127.0.0.1',
      port: 3001,
      logLevel: 'info',
    });
  });
  it('accepts explicit runtime configuration', () => {
    expect(
      readApiConfig({ HOST: '0.0.0.0', PORT: '8080', LOG_LEVEL: 'warn' }),
    ).toEqual({ host: '0.0.0.0', port: 8080, logLevel: 'warn' });
  });
  it.each(['', '0', '-1', '65536', '3001x', '1.5', '1e3', ' 3001'])(
    'rejects invalid port %j',
    (PORT) => {
      expect(() => readApiConfig({ PORT })).toThrow('PORT');
    },
  );
  it('rejects invalid host and logging settings', () => {
    expect(() => readApiConfig({ HOST: ' ' })).toThrow('HOST');
    expect(() => readApiConfig({ LOG_LEVEL: 'verbose' })).toThrow('LOG_LEVEL');
  });
});
