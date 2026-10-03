/**
 * Synthetic Shopify app settings for the local pilot. They enable the real Shopify change
 * webhook route so the simulator can deliver signed webhooks; the HTTPS origin is never
 * contacted and the secret is the run's local webhook secret, not a real app credential.
 * @param {string} secret
 */
export function simulatorShopifyEnv(secret) {
  return {
    SHOPIFY_CLIENT_ID: 'luma-simulator',
    SHOPIFY_CLIENT_SECRET: secret,
    SHOPIFY_APP_ENVIRONMENT: 'simulator',
    SHOPIFY_CALLBACK_URL:
      'https://luma-simulator.invalid/api/v1/shopify/callback',
    SHOPIFY_WEB_ORIGIN: 'https://luma-simulator.invalid',
    SHOPIFY_PROTECTED_CUSTOMER_DATA_APPROVED: 'true',
    SHOPIFY_CUSTOMER_CONTACT_APPROVED: 'true',
    SHOPIFY_CUSTOMER_ADDRESS_APPROVED: 'true',
    SHOPIFY_ALL_ORDERS_APPROVED: 'true',
  };
}
