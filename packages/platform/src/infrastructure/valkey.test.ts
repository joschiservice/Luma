import { beforeEach, describe, expect, it, vi } from 'vitest';

const glide = vi.hoisted(() => {
  class ValkeyError extends Error {}

  class ClosingError extends ValkeyError {}

  class RequestError extends ValkeyError {}

  class TimeoutError extends RequestError {}

  class ConnectionError extends RequestError {}

  const client = {
    invokeScript: vi.fn<() => Promise<unknown>>(),
    ping: vi.fn(async () => 'PONG'),
    close: vi.fn(),
  };
  const createClient = vi.fn(async () => client);

  return {
    client,
    createClient,
    module: {
      ClosingError,
      ConnectionError,
      RequestError,
      TimeoutError,
      GlideClient: { createClient },
      GlideClusterClient: { createClient },
      Script: class {
        release() {}
      },
    },
  };
});

vi.mock('@valkey/valkey-glide', () => glide.module);

const { createValkeyStore } = await import('./valkey.js');

describe('createValkeyStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ['script', new glide.module.RequestError('ERR script failed')],
    ['timeout', new glide.module.TimeoutError('timed out')],
  ])('keeps the shared connection after a %s error', async (_kind, failure) => {
    const store = createValkeyStore('redis://localhost:6379');
    glide.client.invokeScript
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(1);

    await expect(store.run('return 1', 'key', [])).rejects.toBe(failure);
    await expect(store.run('return 1', 'key', [])).resolves.toBe(1);
    expect(glide.client.close).not.toHaveBeenCalled();
    expect(glide.createClient).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['closed', new glide.module.ClosingError('closed')],
    ['refused', new glide.module.ConnectionError('refused')],
  ])(
    'closes a %s connection and backs off before reopening',
    async (_kind, failure) => {
      const store = createValkeyStore('redis://localhost:6379');
      glide.client.invokeScript.mockRejectedValueOnce(failure);

      await expect(store.run('return 1', 'key', [])).rejects.toBe(failure);
      expect(glide.client.close).toHaveBeenCalledTimes(1);
      await expect(store.run('return 1', 'key', [])).rejects.toThrow(
        'Request admission is unavailable',
      );
      expect(glide.createClient).toHaveBeenCalledTimes(1);
    },
  );
});
