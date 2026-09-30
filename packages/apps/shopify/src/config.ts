export interface ShopifyConfig {
  protectedCustomerDataApproved?: boolean;
  allOrdersApproved?: boolean;
  clientId: string;
  clientSecret: string;
  environment: string;
  callbackUrl: string;
  webOrigin: string;
}

/**
 * Returns undefined when Shopify is unconfigured; partial or invalid OAuth settings throw an
 * error.
 */
export function readShopifyConfig(
  env: Readonly<Record<string, string | undefined>>,
): ShopifyConfig | undefined {
  const names = [
    'SHOPIFY_CLIENT_ID',
    'SHOPIFY_CLIENT_SECRET',
    'SHOPIFY_APP_ENVIRONMENT',
    'SHOPIFY_CALLBACK_URL',
    'SHOPIFY_WEB_ORIGIN',
  ] as const;
  if (!names.some((name) => env[name])) return undefined;
  if (names.some((name) => !env[name]?.trim()))
    throw new Error('Configure all SHOPIFY app settings');
  const callback = new URL(env.SHOPIFY_CALLBACK_URL!);
  const web = new URL(env.SHOPIFY_WEB_ORIGIN!);
  if (
    callback.protocol !== 'https:' ||
    callback.username ||
    callback.password ||
    callback.search ||
    callback.hash ||
    callback.pathname !== '/api/v1/shopify/callback'
  )
    throw new Error(
      'SHOPIFY_CALLBACK_URL must be an HTTPS URL ending in /api/v1/shopify/callback',
    );
  if (
    !['https:', 'http:'].includes(web.protocol) ||
    web.origin !== env.SHOPIFY_WEB_ORIGIN ||
    (env.NODE_ENV === 'production' && web.protocol !== 'https:')
  )
    throw new Error('SHOPIFY_WEB_ORIGIN must be an exact web origin');
  if (web.origin !== callback.origin)
    throw new Error(
      'SHOPIFY_WEB_ORIGIN must match the callback origin so the signed-in session is available',
    );
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(env.SHOPIFY_APP_ENVIRONMENT!))
    throw new Error('SHOPIFY_APP_ENVIRONMENT is invalid');

  for (const name of [
    'SHOPIFY_PROTECTED_CUSTOMER_DATA_APPROVED',
    'SHOPIFY_CUSTOMER_CONTACT_APPROVED',
    'SHOPIFY_CUSTOMER_ADDRESS_APPROVED',
    'SHOPIFY_ALL_ORDERS_APPROVED',
  ]) {
    if (env[name] !== undefined && !['true', 'false'].includes(env[name]!))
      throw new Error(`${name} must be true or false`);
  }

  return {
    allOrdersApproved: env.SHOPIFY_ALL_ORDERS_APPROVED === 'true',
    ...(env.SHOPIFY_PROTECTED_CUSTOMER_DATA_APPROVED === 'true'
      ? { protectedCustomerDataApproved: true }
      : {}),
    clientId: env.SHOPIFY_CLIENT_ID!,
    clientSecret: env.SHOPIFY_CLIENT_SECRET!,
    environment: env.SHOPIFY_APP_ENVIRONMENT!,
    callbackUrl: callback.href,
    webOrigin: web.origin,
  };
}
