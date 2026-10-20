import { createHmac, randomBytes } from 'node:crypto';

import { createSecretCipher } from '@luma/connections/composition';
import { expect, it, vi } from 'vitest';

import { createPrivacyIntake } from './privacy.js';

const config = {
  clientId: 'client',
  clientSecret: 'secret',
  environment: 'development',
  callbackUrl: 'https://luma.test/api/v1/shopify/callback',
  webOrigin: 'https://luma.test',
};
const shop = 'test.myshopify.com';
const base = { shop_id: 123, shop_domain: shop };
const cipher = createSecretCipher('test', new Map([['test', randomBytes(32)]]));

function fixture() {
  const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 1 });
  const transaction = vi.fn(async (_tenant, run) => run({ query }));
  const intake = createPrivacyIntake({ transaction }, config, cipher);
  const send = (topic: string, payload: unknown, domain = shop) => {
    const body = Buffer.from(JSON.stringify(payload));

    return intake(
      body,
      createHmac('sha256', config.clientSecret).update(body).digest('base64'),
      domain,
      topic,
    );
  };

  return { query, transaction, intake, send };
}

it.each([
  ['shop/redact', base],
  [
    'customers/redact',
    { ...base, customer: { id: 456 }, orders_to_redact: [123] },
  ],
  [
    'customers/data_request',
    {
      ...base,
      customer: { email: 'customer@example.test' },
      orders_requested: Array.from({ length: 2000 }, (_, index) => index + 1),
      data_request: { id: 12 },
    },
  ],
])(
  'durably stores encrypted %s requests, including large histories',
  async (topic, payload) => {
    const f = fixture();
    const inserts = () =>
      f.query.mock.calls.filter(([sql]) =>
        String(sql).includes('INSERT INTO shopify_privacy_requests'),
      );
    await f.send(topic, payload);
    const values = inserts()[0]![1];
    expect(values[4]).not.toContain('myshopify.com');
    const envelope = cipher.open(
      values[4],
      JSON.stringify(['shopify-privacy', values[1], values[2]]),
    );
    expect(envelope.request).toEqual(payload);
    await f.send(topic, payload);
    expect(inserts()[1]![1][2]).toBe(values[2]);
    expect(inserts()[0]![0]).toContain('ON CONFLICT DO NOTHING');
  },
);
it('erases imported customer profiles, order addresses and inbox data with redaction intake', async () => {
  const f = fixture();
  const erasures = () =>
    f.query.mock.calls
      .filter(([sql]) => String(sql).includes('erase_shopify_customer_data'))
      .map(([, values]) => values);
  await f.send('customers/redact', {
    ...base,
    customer: { id: 456 },
    orders_to_redact: [],
  });
  await f.send('shop/redact', base);
  await f.send('customers/data_request', {
    ...base,
    customer: { id: 456 },
    orders_requested: [],
    data_request: { id: 1 },
  });
  // A request that names only orders erases their addresses, never every customer.
  await f.send('customers/redact', {
    ...base,
    customer: { email: 'customer@example.test' },
    orders_to_redact: [7, 8],
  });
  await f.send('customers/redact', {
    ...base,
    customer: { email: ' Customer@Example.test ' },
    orders_to_redact: [],
  });
  // The signed email reaches the inbox even when no stored profile holds it.
  expect(erasures().map((values) => values.slice(0, 5))).toEqual([
    ['development:client', shop, ['gid://shopify/Customer/456'], [], []],
    ['development:client', shop, null, null, null],
    [
      'development:client',
      shop,
      [],
      ['gid://shopify/Order/7', 'gid://shopify/Order/8'],
      ['customer@example.test'],
    ],
    ['development:client', shop, [], [], ['customer@example.test']],
  ]);
  // Activity is keyed by the signed request's digest, never by the customer.
  expect(erasures().map((values) => values[5])).toEqual(
    erasures().map(() => expect.stringMatching(/^[0-9a-f]{64}$/)),
  );
});
it('rejects bad signatures before parsing or persistence', async () => {
  const f = fixture();
  await expect(
    f.intake(Buffer.from('not JSON'), '', shop, 'shop/redact'),
  ).rejects.toMatchObject({ statusCode: 401 });
  expect(f.transaction).not.toHaveBeenCalled();
});
it('rejects mismatched shops, unknown topics, malformed bodies and unsafe IDs', async () => {
  const f = fixture();
  await expect(
    f.send('shop/redact', base, 'other.myshopify.com'),
  ).rejects.toThrow();
  await expect(f.send('orders/create', base)).rejects.toThrow();
  await expect(f.send('customers/redact', base)).rejects.toThrow();
  await expect(
    f.send('shop/redact', { ...base, shop_id: Number.MAX_SAFE_INTEGER + 1 }),
  ).rejects.toThrow();
  expect(f.transaction).not.toHaveBeenCalled();
});
it('does not acknowledge failed persistence', async () => {
  const f = fixture();
  f.query.mockRejectedValue(new Error('Database unavailable'));
  await expect(f.send('shop/redact', base)).rejects.toThrow(
    'Database unavailable',
  );
});
it('queues the shop for data removal only on shop/redact', async () => {
  const f = fixture();
  const queued = () =>
    f.query.mock.calls
      .filter(([sql]) => String(sql).includes('erase_shopify_shop_data'))
      .map(([, values]) => values);
  await f.send('customers/redact', {
    ...base,
    customer: { id: 456 },
    orders_to_redact: [],
  });
  expect(queued()).toEqual([]);
  await f.send('shop/redact', base);
  expect(queued()).toEqual([['development:client', shop]]);
});
it('rejects a signed customers/data_request body relabelled as shop/redact', async () => {
  const f = fixture();
  const body = Buffer.from(
    JSON.stringify({
      ...base,
      customer: { id: 456, email: 'customer@example.test' },
      orders_requested: [1],
      data_request: { id: 12 },
    }),
  );
  const signature = createHmac('sha256', config.clientSecret)
    .update(body)
    .digest('base64');
  await expect(
    f.intake(body, signature, shop, 'shop/redact'),
  ).rejects.toMatchObject({ statusCode: 422 });
  await expect(
    f.intake(body, signature, shop, 'customers/redact'),
  ).rejects.toMatchObject({ statusCode: 422 });
  expect(f.transaction).not.toHaveBeenCalled();
});
