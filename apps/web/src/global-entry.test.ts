import { describe, expect, it } from 'vitest';

import { globalEntryRedirect } from './global-entry';

const env = {
  LUMA_REGION: 'AU',
  LUMA_GLOBAL_ENTRY_URL: 'https://app.example.test',
  LUMA_REGIONAL_ORIGINS: '{"AU":"https://au.app.example.test"}',
};

describe('session-free global entry', () => {
  it('redirects before rendering and drops paths, queries and cookies', () => {
    const response = globalEntryRedirect(
      new Request('https://app.example.test/app/private?token=secret', {
        headers: { cookie: 'session=private' },
      }),
      env,
    );
    expect(response?.status).toBe(302);
    expect(response?.headers.get('location')).toBe(
      'https://au.app.example.test/',
    );
    expect(response?.headers.get('set-cookie')).toBeNull();
    expect(response?.headers.get('cache-control')).toBe('no-store');
    expect(response?.headers.get('referrer-policy')).toBe('no-referrer');
  });
  it('leaves regional rendering to the application', () => {
    expect(
      globalEntryRedirect(
        new Request('https://au.app.example.test/sign-up'),
        env,
      ),
    ).toBeUndefined();
  });
  it('rejects missing destinations and redirect loops', () => {
    expect(() =>
      globalEntryRedirect(new Request('https://app.example.test'), {
        ...env,
        LUMA_REGIONAL_ORIGINS: '{}',
      }),
    ).toThrow();
    expect(() =>
      globalEntryRedirect(new Request('https://app.example.test'), {
        ...env,
        LUMA_REGIONAL_ORIGINS: '{"AU":"https://app.example.test"}',
      }),
    ).toThrow();
  });
  it('rejects credentialed, non-web and path-bearing origins and insecure production destinations', () => {
    for (const destination of [
      'https://user:secret@au.app.example.test',
      'ftp://au.app.example.test',
      'https://au.app.example.test/sign-up',
    ]) {
      expect(() =>
        globalEntryRedirect(new Request(env.LUMA_GLOBAL_ENTRY_URL), {
          ...env,
          LUMA_REGIONAL_ORIGINS: JSON.stringify({ AU: destination }),
        }),
      ).toThrow();
    }
    expect(() =>
      globalEntryRedirect(new Request(env.LUMA_GLOBAL_ENTRY_URL), {
        ...env,
        NODE_ENV: 'production',
        LUMA_REGIONAL_ORIGINS: '{"AU":"http://au.app.example.test"}',
      }),
    ).toThrow('HTTPS');
  });
});
