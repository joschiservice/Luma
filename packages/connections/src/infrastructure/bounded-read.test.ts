import { expect, it, vi } from 'vitest';

import { boundedReadTransport } from './bounded-read.js';

it('preserves selected transport and request cancellation, and aborts future attempts after deadline', async () => {
  const controller = new AbortController();
  const underlying = vi.fn<typeof fetch>(async (_, init) => {
    expect(init?.signal).toBeInstanceOf(AbortSignal);

    return new Response('bounded');
  });
  const bounded = boundedReadTransport(underlying, {
    signal: controller.signal,
    maxRequests: 2,
    maxResponseBytes: 16,
    maxTotalBytes: 16,
  });
  expect(await (await bounded('https://approved.test')).text()).toBe('bounded');
  controller.abort();
  await expect(bounded('https://approved.test')).rejects.toMatchObject({
    failure: { code: 'timeout', effect: 'none', retry: 'never' },
  });
  expect(underlying).toHaveBeenCalledTimes(1);
});

it('bounds response bytes and request count before parsing, cancels oversized streams and retains no payload', async () => {
  const cancelled = vi.fn();
  const transport = vi.fn<typeof fetch>(
    async () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new Uint8Array(20));
          },
          cancel: cancelled,
        }),
      ),
  );
  const bounded = boundedReadTransport(transport, {
    signal: new AbortController().signal,
    maxRequests: 1,
    maxResponseBytes: 10,
    maxTotalBytes: 10,
  });
  await expect(bounded('https://approved.test')).rejects.toMatchObject({
    failure: { code: 'invalid_response' },
  });
  expect(cancelled).toHaveBeenCalledOnce();
  await expect(bounded('https://approved.test')).rejects.toMatchObject({
    failure: { retry: 'never' },
  });
  expect(transport).toHaveBeenCalledOnce();
});

it('cancels a stalled response body when the caller aborts', async () => {
  const cancelled = vi.fn(),
    controller = new AbortController();
  const bounded = boundedReadTransport(
    async () => new Response(new ReadableStream({ cancel: cancelled })),
    {
      signal: controller.signal,
      maxRequests: 1,
      maxResponseBytes: 10,
      maxTotalBytes: 10,
    },
  );
  const reading = bounded('https://approved.test');
  await Promise.resolve();
  controller.abort();
  await expect(reading).rejects.toMatchObject({ failure: { code: 'timeout' } });
  expect(cancelled).toHaveBeenCalledOnce();
});
