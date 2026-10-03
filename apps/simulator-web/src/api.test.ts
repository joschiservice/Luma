import { describe, expect, it, vi } from 'vitest';

import { ApiError, createSimulatorApi } from './api';

function respond(status: number, body?: unknown) {
  return vi.fn<typeof fetch>(
    async () =>
      new Response(body === undefined ? null : JSON.stringify(body), {
        status,
      }),
  );
}

describe('createSimulatorApi', () => {
  it('sends the bearer token and JSON bodies', async () => {
    const fetcher = respond(200, { id: 'a' });
    const api = createSimulatorApi('secret', fetcher);
    await api.control('run 1', { action: 'pause' });
    const [url, init] = fetcher.mock.calls[0] ?? [];
    expect(url).toBe('/api/runs/run%201/control');
    expect(init).toMatchObject({
      method: 'POST',
      headers: {
        authorization: 'Bearer secret',
        'content-type': 'application/json',
      },
      body: '{"action":"pause"}',
    });
  });

  it('omits empty query parameters', async () => {
    const fetcher = respond(200, { items: [], nextCursor: null });
    await createSimulatorApi('t', fetcher).journal('r', {
      limit: 100,
      kind: '',
      before: 42,
    });
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      '/api/runs/r/journal?limit=100&before=42',
    );
  });

  it('returns nothing for 204 responses', async () => {
    await expect(
      createSimulatorApi('t', respond(204)).deleteRun('r'),
    ).resolves.toBeUndefined();
  });

  it('raises the host error message with its status', async () => {
    const error = await createSimulatorApi(
      't',
      respond(409, { error: 'Run exists' }),
    )
      .createRun({ id: 'r' })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ message: 'Run exists', status: 409 });
  });

  it('explains rejected tokens and unreachable hosts', async () => {
    await expect(
      createSimulatorApi('t', respond(401)).runs(),
    ).rejects.toMatchObject({
      status: 401,
      message: 'The simulator rejected the access token.',
    });
    const offline = vi.fn<typeof fetch>(async () => {
      throw new TypeError('fetch failed');
    });
    await expect(createSimulatorApi('t', offline).runs()).rejects.toMatchObject(
      {
        status: 0,
        message: 'The simulator is unreachable.',
      },
    );
  });

  it('rejects unreadable successful responses', async () => {
    const fetcher = vi.fn<typeof fetch>(
      async () => new Response('<html>', { status: 200 }),
    );
    await expect(createSimulatorApi('t', fetcher).runs()).rejects.toMatchObject(
      {
        message: 'The simulator returned an unreadable response.',
      },
    );
  });
});
