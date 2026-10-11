import { readFileSync } from 'node:fs';

import { buildSchema, isEnumType } from 'graphql';
import { expect, it } from 'vitest';

import { canSubscribe, shopifyChangeTopics } from './webhooks.js';

it('registers exactly the mapped change topics supported by the pinned schema', () => {
  const schema = buildSchema(
    readFileSync(
      new URL('./fixtures/admin-2026-07.graphql', import.meta.url),
      'utf8',
    ),
  );
  const topic = schema.getType('WebhookSubscriptionTopic');
  if (!isEnumType(topic)) throw new Error('Missing topic enum');
  const values = new Set(topic.getValues().map((value) => value.name));
  for (const mapped of Object.keys(shopifyChangeTopics))
    expect(values.has(mapped.replaceAll('/', '_').toUpperCase()), mapped).toBe(
      true,
    );
});

it('admits subscriptions only with actual grants and deployment approvals', () => {
  for (const topic of Object.keys(shopifyChangeTopics))
    expect(canSubscribe(topic, [], true), topic).toBe(false);
  expect(canSubscribe('customers/delete', ['read_customers'], false)).toBe(
    false,
  );
  expect(canSubscribe('customers/delete', ['read_customers'], true)).toBe(true);
  expect(
    canSubscribe('inventory_levels/disconnect', ['write_inventory'], false),
  ).toBe(true);
  expect(canSubscribe('locations/update', ['read_inventory'], false)).toBe(
    false,
  );
  expect(canSubscribe('fulfillment_holds/added', ['read_orders'], false)).toBe(
    false,
  );
  expect(
    canSubscribe(
      'fulfillment_holds/added',
      ['read_third_party_fulfillment_orders'],
      false,
    ),
  ).toBe(true);
});
