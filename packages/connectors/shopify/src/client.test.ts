import { describe, expect, it, vi } from 'vitest';

import { createClient } from './client.js';

function fixture() {
  const fetch = vi.fn<typeof globalThis.fetch>(
    async () => new Response('', { status: 503 }),
  );
  const request = createClient({
    shop: 'example.myshopify.com',
    accessToken: async () => 'token',
    fetch,
    readRetry: { attempts: 3, maxDelayMs: 2000, sleep: async () => undefined },
  });

  return { fetch, request };
}

describe('Shopify client retries', () => {
  it('repeats queries after transient failures', async () => {
    const f = fixture();
    f.fetch.mockResolvedValueOnce(new Response('', { status: 500 }));
    f.fetch.mockResolvedValueOnce(Response.json({ data: { shop: {} } }));

    await expect(f.request('query Shop { shop { id } }', {})).resolves.toEqual({
      shop: {},
    });
    expect(f.fetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    'mutation Set { inventorySetQuantities { userErrors { message } } }',
    '# comment\nquery Shop { shop { id } }',
  ])('sends other documents once: %s', async (document) => {
    const f = fixture();

    await expect(f.request(document, {})).rejects.toThrow('transient');
    expect(f.fetch).toHaveBeenCalledTimes(1);
  });
});

describe('Shopify client errors', () => {
  it('keeps the provider code of a rejected query for diagnosis', async () => {
    const f = fixture();
    f.fetch.mockResolvedValueOnce(
      Response.json({
        errors: [
          {
            message: 'Query cost is 1352, which exceeds the limit (1000).',
            extensions: { code: 'MAX_COST_EXCEEDED', cost: 1352 },
          },
        ],
      }),
    );

    await expect(
      f.request('query Orders { orders(first: 25) { nodes { id } } }', {}),
    ).rejects.toMatchObject({
      failure: {
        code: 'invalid_response',
        providerCode: 'MAX_COST_EXCEEDED',
        retry: 'never',
      },
    });
    expect(f.fetch).toHaveBeenCalledTimes(1);
  });
});
