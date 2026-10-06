import { expect, it } from 'vitest';

import { redactHeaders, redactUrl } from './redaction.js';

const id = '0d42a910-c406-40d5-8a85-c82b2ccdbfda';

it('keeps route words and record UUIDs while replacing other route values with their names', () => {
  expect(
    redactUrl(
      `/v1/organizations/${id}/products/sku%20private/history?window=7d&limit=50&sort=private%20name`,
      '/v1/organizations/:organizationId/products/:skuId/history',
    ),
  ).toBe(
    `/v1/organizations/${id}/products/:skuId/history?window=7d&limit=50&sort=[Filtered]`,
  );
});

it('filters values without a route, including OAuth callback parameters', () => {
  expect(
    redactUrl(
      '/v1/shopify/callback/shop-123.myshopify.com?code=oauth-code&state=oauth-state&hmac=signature',
    ),
  ).toBe(
    '/v1/shopify/callback/[Filtered]?code=[Filtered]&state=[Filtered]&hmac=[Filtered]',
  );
  expect(
    redactUrl(
      `https://luma.example/app/${id}/orders?q=private@example.com`,
      'unmatched',
    ),
  ).toBe(`https://luma.example/app/${id}/orders?q=[Filtered]`);
});

it('filters credentials, signatures and client addresses and redacts referrers', () => {
  expect(
    redactHeaders({
      Cookie: 'session=secret',
      'x-shopify-hmac-sha256': 'signature',
      'x-shopify-shop-domain': 'private.myshopify.com',
      'x-amz-security-token': 'token',
      'x-real-ip': '203.0.113.9',
      referer: 'https://luma.example/app/orders?q=private',
      accept: ['application/json', 'text/plain'],
      'content-length': undefined,
    }),
  ).toEqual({
    cookie: '[Filtered]',
    'x-shopify-hmac-sha256': '[Filtered]',
    'x-shopify-shop-domain': '[Filtered]',
    'x-amz-security-token': '[Filtered]',
    'x-real-ip': '[Filtered]',
    referer: 'https://luma.example/app/orders?q=[Filtered]',
    accept: 'application/json, text/plain',
  });
});
