import { readFileSync } from 'node:fs';

import { ConnectorError } from '@luma/connections';
import { buildSchema, parse, validate } from 'graphql';
import { expect, it, vi } from 'vitest';

import { createBundleReader } from './bundles.js';

const schema = buildSchema(
  readFileSync(
    new URL('./fixtures/admin-2026-07.graphql', import.meta.url),
    'utf8',
  ),
);
const gid = (kind: string, id: number) => `gid://shopify/${kind}/${id}`;
const component = (id: number) => ({
  id: gid('ProductVariantComponent', id),
  quantity: 2,
  productVariant: {
    id: gid('ProductVariant', id + 100),
    inventoryItem: { id: gid('InventoryItem', id + 200) },
  },
});

it('drains recipes in bounded batches, including optional parents, and maps only exact inventory item identities', async () => {
  const request = vi.fn(
    async (query: string, variables: Record<string, unknown>) => {
      expect(validate(schema, parse(query))).toEqual([]);
      const result: Record<string, unknown> = {};
      for (let i = 0; variables[`id${i}`]; i++)
        result[`v${i}`] = {
          productVariantComponents: {
            nodes: [
              component(
                Number(String(variables[`id${i}`]).split('/').at(-1)) +
                  (variables[`after${i}`] ? 1000 : 0),
              ),
            ],
            pageInfo: {
              hasNextPage: !variables[`after${i}`],
              endCursor: variables[`after${i}`] ? null : 'next',
            },
          },
        };

      return result;
    },
  );
  const result = await createBundleReader(request)(
    Array.from({ length: 12 }, (_, i) => ({
      id: gid('ProductVariant', i + 1),
      requiresComponents: i % 2 === 0,
    })),
  );
  expect(request).toHaveBeenCalledTimes(4);
  expect(result.get(gid('ProductVariant', 2))).toMatchObject({
    requiresComponents: false,
    components: [
      { sku: { externalId: gid('InventoryItem', 202) } },
      { sku: { externalId: gid('InventoryItem', 1202) } },
    ],
  });
  expect(
    result.get(gid('ProductVariant', 1))?.components?.[0]?.variant.externalId,
  ).toBe(gid('ProductVariant', 101));
});

it('keeps a missing parent, unread flag and unavailable item distinct from a confirmed empty recipe', async () => {
  const request = vi.fn(async () => ({
    v0: null,
    v1: {
      productVariantComponents: {
        nodes: [],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    },
    v2: {
      productVariantComponents: {
        nodes: [
          {
            ...component(1),
            productVariant: {
              id: gid('ProductVariant', 11),
              inventoryItem: null,
            },
          },
        ],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    },
  }));
  const result = await createBundleReader(request)([
    { id: gid('ProductVariant', 1), requiresComponents: true },
    { id: gid('ProductVariant', 2), requiresComponents: false },
    { id: gid('ProductVariant', 3), requiresComponents: true },
    { id: gid('ProductVariant', 4) },
  ]);
  expect(result.get(gid('ProductVariant', 1))?.components).toBeNull();
  expect(result.get(gid('ProductVariant', 2))?.components).toEqual([]);
  expect(result.get(gid('ProductVariant', 3))?.components?.[0]?.sku).toBeNull();
  expect(result.has(gid('ProductVariant', 4))).toBe(false);
});

it.each(['repeated cursor', 'duplicate component', 'invalid quantity'])(
  'rejects %s without publishing a partial recipe',
  async (failure) => {
    const request = async () => ({
      v0: {
        productVariantComponents: {
          nodes:
            failure === 'duplicate component'
              ? [component(1), component(1)]
              : [
                  {
                    ...component(1),
                    quantity: failure === 'invalid quantity' ? -1 : 2,
                  },
                ],
          pageInfo: {
            hasNextPage: failure === 'repeated cursor',
            endCursor: failure === 'repeated cursor' ? 'same' : null,
          },
        },
      },
    });
    await expect(
      createBundleReader(request)([
        { id: gid('ProductVariant', 1), requiresComponents: true },
      ]),
    ).rejects.toBeInstanceOf(ConnectorError);
  },
);

it('uses the first catalog edge to avoid requests for empty recipes and drains only overflow', async () => {
  const request = vi.fn(
    async (query: string, variables: Record<string, unknown>) => {
      expect(validate(schema, parse(query))).toEqual([]);
      expect(variables.after0).toBe('first');

      return {
        v0: {
          productVariantComponents: {
            nodes: [component(2)],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      };
    },
  );
  const result = await createBundleReader(request)([
    {
      id: gid('ProductVariant', 1),
      requiresComponents: false,
      productVariantComponents: {
        nodes: [],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    },
    {
      id: gid('ProductVariant', 2),
      requiresComponents: true,
      productVariantComponents: {
        nodes: [component(1)],
        pageInfo: { hasNextPage: true, endCursor: 'first' },
      },
    },
  ]);
  expect(request).toHaveBeenCalledTimes(1);
  expect(request.mock.calls[0]?.[1]).toEqual({
    id0: gid('ProductVariant', 2),
    after0: 'first',
  });
  expect(result.get(gid('ProductVariant', 1))?.components).toEqual([]);
  expect(result.get(gid('ProductVariant', 2))?.components).toHaveLength(2);
});
