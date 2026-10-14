/**
 * Synthetic Shopify app settings for the local pilot. They enable the real Shopify change
 * webhook route so the simulator can deliver signed webhooks; the HTTPS origin is never
 * contacted and the secret is the run's local webhook secret, not a real app credential.
 * @param {string} secret
 * @param {Record<string, string | undefined>} env Trusted cell and admission settings.
 */
export function simulatorShopifyEnv(secret, env = {}) {
  return {
    LUMA_REGION: env.LUMA_REGION ?? process.env.LUMA_REGION ?? 'AU',
    ...(env.SHOPIFY_ADMISSION_URL
      ? { SHOPIFY_ADMISSION_URL: env.SHOPIFY_ADMISSION_URL }
      : {}),
    ...(env.SHOPIFY_ADMISSION_CLUSTER
      ? { SHOPIFY_ADMISSION_CLUSTER: env.SHOPIFY_ADMISSION_CLUSTER }
      : {}),
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
