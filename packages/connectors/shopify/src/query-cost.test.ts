import { describe, expect, it } from 'vitest';

import { calculateQueryCost } from './query-cost.js';

describe('Shopify query cost calculation', () => {
  it('charges objects, sized connections and lists, but not scalars', () => {
    expect(calculateQueryCost('query Shop { shop { id name } }', {})).toBe(1);
    // Connection 2 + 5 nodes × (node 1 + nested connection 2 + 10 × (line 1 + variant 1)).
    expect(
      calculateQueryCost(
        'query Orders($first: Int!) { orders(first: $first) { nodes { id lineItems(first: 10) { nodes { id variant { id } } pageInfo { hasNextPage } } } pageInfo { hasNextPage endCursor } } }',
        { first: 5 },
      ),
    ).toBe(2 + 5 * (1 + 2 + 10 * 2));
    expect(
      calculateQueryCost(
        'query Edges { orders(first: 3) { edges { cursor node { id } } } }',
        {},
      ),
    ).toBe(2 + 3 * (1 + 1));
    expect(
      calculateQueryCost(
        'query Payments($id: ID!) { node(id: $id) { ... on Order { transactions(first: 4) { id amountSet { shopMoney { amount } } } } } }',
        { id: 'gid://shopify/Order/1' },
      ),
    ).toBe(1 + 4 * (1 + 1 + 1));
  });

  it('charges the most expensive type branch and every untyped fragment', () => {
    expect(
      calculateQueryCost(
        'query Node($id: ID!) { node(id: $id) { ... on Order { customer { id } } ... on Product { variants(first: 2) { nodes { id } } } ...Shared } } fragment Shared on Node { id }',
        {},
      ),
    ).toBe(1 + Math.max(1, 2 + 2));
    expect(
      calculateQueryCost(
        'query Node { node(id: "1") { ... { owner { id } } ... @include(if: true) { parent { id } } } }',
        {},
      ),
    ).toBe(1 + 1 + 1);
  });

  it('charges ten per mutation field and at least one point per query', () => {
    expect(
      calculateQueryCost(
        'mutation Release($id: ID!) { fulfillmentOrderReleaseHold(id: $id) { fulfillmentOrder { id } userErrors { field message } } }',
        {},
      ),
    ).toBe(10);
    expect(calculateQueryCost('{ __typename }', {})).toBe(1);
  });

  it('caps at the single-query maximum and leaves malformed documents uncosted', () => {
    expect(
      calculateQueryCost(
        'query Big { orders(first: 250) { nodes { lineItems(first: 250) { nodes { id } } } } }',
        {},
      ),
    ).toBe(1000);
    expect(calculateQueryCost('query Broken {', {})).toBeUndefined();
    expect(
      calculateQueryCost('query A { shop { id } } query B { shop { id } }', {}),
    ).toBeUndefined();
    expect(
      calculateQueryCost('subscription Events { shop { id } }', {}),
    ).toBeUndefined();
  });
});
