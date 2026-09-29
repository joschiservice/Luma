import { expect, it } from 'vitest';

import { readShopifyConfig } from './config.js';

const settings = {
  SHOPIFY_CLIENT_ID: 'client',
  SHOPIFY_CLIENT_SECRET: 'secret',
  SHOPIFY_APP_ENVIRONMENT: 'development',
  SHOPIFY_CALLBACK_URL: 'https://luma.test/api/v1/shopify/callback',
  SHOPIFY_WEB_ORIGIN: 'https://luma.test',
};

it('requires a complete app configuration and exact HTTPS callback', () => {
  expect(readShopifyConfig({})).toBeUndefined();
  expect(readShopifyConfig(settings)?.environment).toBe('development');
  expect(() => readShopifyConfig({ SHOPIFY_CLIENT_ID: 'client' })).toThrow();
  for (const url of [
    'http://luma.test/api/v1/shopify/callback',
    'https://luma.test/wrong',
    'https://luma.test/api/v1/shopify/callback?x=y',
    'https://secret@luma.test/api/v1/shopify/callback',
  ])
    expect(() =>
      readShopifyConfig({ ...settings, SHOPIFY_CALLBACK_URL: url }),
    ).toThrow();
  expect(() =>
    readShopifyConfig({
      ...settings,
      NODE_ENV: 'production',
      SHOPIFY_WEB_ORIGIN: 'http://luma.test',
    }),
  ).toThrow();
});

it('enables approved access explicitly and rejects mistyped approval settings', () => {
  expect(readShopifyConfig(settings)?.allOrdersApproved).toBe(false);
  expect(
    readShopifyConfig({ ...settings, SHOPIFY_ALL_ORDERS_APPROVED: 'true' })
      ?.allOrdersApproved,
  ).toBe(true);
  for (const name of [
    'SHOPIFY_ALL_ORDERS_APPROVED',
    'SHOPIFY_PROTECTED_CUSTOMER_DATA_APPROVED',
    'SHOPIFY_CUSTOMER_CONTACT_APPROVED',
  ])
    expect(() => readShopifyConfig({ ...settings, [name]: 'yes' })).toThrow();
});
