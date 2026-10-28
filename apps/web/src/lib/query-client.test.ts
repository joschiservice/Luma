import { QueryObserver } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';

import { createQueryClient } from './query-client';

describe('request-scoped Query clients', () => {
  it('does not share one request’s server data with another', () => {
    const first = createQueryClient();
    const second = createQueryClient();
    try {
      first.setQueryData(['current-user'], { name: 'Ada' });
      expect(second.getQueryData(['current-user'])).toBeUndefined();
    } finally {
      first.clear();
      second.clear();
    }
  });
});

it('notifies a mounted session observer when a private request returns 401', async () => {
  const client = createQueryClient();
  const sessionKey = ['private', 'session'];
  client.setQueryData(sessionKey, { user: { name: 'Ada' } });
  client.setQueryData(['private', 'organization', 'previous'], 'private data');
  const observer = new QueryObserver(client, {
    queryKey: sessionKey,
    enabled: false,
  });
  let session: unknown;
  const unsubscribe = observer.subscribe((result) => {
    session = result.data;
  });
  const error = Object.assign(new Error('Session expired'), { status: 401 });
  try {
    await expect(
      client.fetchQuery({
        queryKey: ['private', 'organizations'],
        queryFn: () => {
          throw error;
        },
        retry: false,
      }),
    ).rejects.toThrow('Session expired');
    await expect.poll(() => session).toBeNull();
    expect(
      client.getQueryData(['private', 'organization', 'previous']),
    ).toBeUndefined();
    expect(client.getQueryData(['private', 'organizations'])).toBeUndefined();
  } finally {
    unsubscribe();
    client.clear();
  }
});

it('discards loaded activity pages on workspace access loss', async () => {
  const client = createQueryClient();
  const prefix = ['private', 'organization', 'workspace', 'activity'];
  client.setQueryData([...prefix, 'page'], { items: ['restricted event'] });
  client.setQueryData(
    ['private', 'organization', 'other', 'activity', 'page'],
    { items: ['other workspace'] },
  );
  try {
    await expect(
      client.fetchQuery({
        queryKey: [...prefix, 'head'],
        retry: false,
        queryFn: () => {
          throw Object.assign(new Error('Access lost'), { status: 403 });
        },
      }),
    ).rejects.toThrow('Access lost');
    await expect
      .poll(() => client.getQueryData([...prefix, 'page']))
      .toBeUndefined();
    expect(
      client.getQueryData([
        'private',
        'organization',
        'other',
        'activity',
        'page',
      ]),
    ).toBeDefined();
  } finally {
    client.clear();
  }
});

it('notifies a mounted session observer when a write returns 401', async () => {
  const client = createQueryClient();
  const sessionKey = ['private', 'session'];
  client.setQueryData(sessionKey, { user: { name: 'Ada' } });
  client.setQueryData(['private', 'organization', 'previous'], 'private data');
  const observer = new QueryObserver(client, {
    queryKey: sessionKey,
    enabled: false,
  });
  let session: unknown;
  const unsubscribe = observer.subscribe((result) => {
    session = result.data;
  });
  try {
    await expect(
      client
        .getMutationCache()
        .build(client, {
          mutationFn: () =>
            Promise.reject(
              Object.assign(new Error('Session expired'), { status: 401 }),
            ),
        })
        .execute(undefined),
    ).rejects.toThrow('Session expired');
    await expect.poll(() => session).toBeNull();
    expect(
      client.getQueryData(['private', 'organization', 'previous']),
    ).toBeUndefined();
  } finally {
    unsubscribe();
    client.clear();
  }
});

it('keeps the session when a write fails for another reason', async () => {
  const client = createQueryClient();
  client.setQueryData(['private', 'session'], { user: { name: 'Ada' } });
  try {
    await expect(
      client
        .getMutationCache()
        .build(client, {
          mutationFn: () =>
            Promise.reject(
              Object.assign(new Error('Forbidden'), { status: 403 }),
            ),
        })
        .execute(undefined),
    ).rejects.toThrow('Forbidden');
    expect(client.getQueryData(['private', 'session'])).toEqual({
      user: { name: 'Ada' },
    });
  } finally {
    client.clear();
  }
});
