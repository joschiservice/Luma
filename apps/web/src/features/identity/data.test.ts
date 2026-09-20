import { describe, expect, it } from 'vitest';

import { createQueryClient } from '../../lib/query-client';
import { clearPrivate, organizationSlug, returnPath } from './data';

describe('identity navigation', () => {
  it.each([
    'https://evil.test/app',
    '//evil.test/app',
    '/\\evil.test/app',
    '/app/../../sign-out',
    '/app%2f..%2fsign-out',
    '/application',
    '/sign-in',
    '',
    undefined,
  ])('rejects unsafe return path %s', (value) => {
    expect(returnPath(value)).toBe('/app');
  });
  it('keeps a tenant destination', () => {
    expect(returnPath('/app/abc/exceptions?view=open#case')).toBe(
      '/app/abc/exceptions?view=open#case',
    );
  });
  it('generates valid bounded slugs even for non-Latin names', () => {
    for (const name of ['日本語', 'Crème & Co.', 'a'.repeat(200)]) {
      const slug = organizationSlug(name);
      expect(slug).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      expect(slug.length).toBeLessThanOrEqual(100);
      expect(organizationSlug(name)).not.toBe(slug);
    }
  });
  it('cancels a late response and removes only the previous tenant', async () => {
    const client = createQueryClient();
    let aborted = false;
    let resolve!: (value: string) => void;
    const oldKey = ['private', 'organization', 'old', 'object'];
    const request = client
      .fetchQuery({
        queryKey: oldKey,
        queryFn: ({ signal }) => {
          signal.addEventListener('abort', () => {
            aborted = true;
          });

          return new Promise<string>((done) => {
            resolve = done;
          });
        },
      })
      .catch(() => undefined);
    client.setQueryData(
      ['private', 'organization', 'new', 'object'],
      'new tenant',
    );
    await clearPrivate(client, 'old');
    resolve('old tenant');
    await request;
    expect(aborted).toBe(true);
    expect(client.getQueryData(oldKey)).toBeUndefined();
    expect(
      client.getQueryData(['private', 'organization', 'new', 'object']),
    ).toBe('new tenant');
    await clearPrivate(client);
    expect(client.getQueryCache().getAll()).toHaveLength(0);
  });
});
