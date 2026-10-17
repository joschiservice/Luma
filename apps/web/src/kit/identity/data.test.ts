import { describe, expect, it } from 'vitest';

import { createQueryClient } from '../../lib/query-client';
import {
  clearPrivate,
  IdentityError,
  onClearPrivate,
  organizationSlug,
  returnPath,
} from './data';

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

  it('clears registered private module state with the private cache', async () => {
    const cleared: (string | undefined)[] = [];
    const stop = onClearPrivate((organizationId) =>
      cleared.push(organizationId),
    );
    const client = createQueryClient();
    await clearPrivate(client, 'old');
    await clearPrivate(client);
    stop();
    await clearPrivate(client, 'other');
    expect(cleared).toEqual(['old', undefined]);
  });
});

describe('API errors', () => {
  it('keeps the error payload the server sent', () => {
    const error = new IdentityError(409, {
      code: 'CONFLICT',
      message: 'That workspace address is taken',
      requestId: 'req-1',
    });
    expect(error).toMatchObject({
      status: 409,
      code: 'CONFLICT',
      message: 'That workspace address is taken',
      requestId: 'req-1',
    });
  });

  it('falls back to a generic message without a payload', () => {
    for (const body of [undefined, null, 'Bad gateway', { detail: 'x' }]) {
      const error = new IdentityError(502, body);
      expect(error.status).toBe(502);
      expect(error.code).toBeUndefined();
      expect(error.requestId).toBeUndefined();
      expect(error.message).toBe(
        'Luma couldn’t complete this request. Try again in a moment.',
      );
    }
  });

  it('keeps a server message but ignores codes outside the API contract', () => {
    const error = new IdentityError(401, {
      code: 'SESSION_EXPIRED',
      message: 'Session expired',
    });
    expect(error.code).toBeUndefined();
    expect(error.message).toBe('Session expired');
  });
});
