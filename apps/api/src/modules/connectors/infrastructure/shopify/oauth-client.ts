import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { ShopifyAppConfig as ShopifyConfig } from '#modules/connectors/application/shopify';
import type { InstallationCredentials } from '#modules/connectors/domain/installation';
import { ConnectorError } from '#modules/connectors/domain/capabilities';

export const shopHostname = z
  .string()
  .max(253)
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.myshopify\.com$/);
export const shopifyScopes = [
  'read_orders',
  'read_products',
  'read_inventory',
  'read_merchant_managed_fulfillment_orders',
  'read_third_party_fulfillment_orders',
];
export const shopifyReads = [
  'orders.read',
  'products.read',
  'inventory.read',
  'fulfillment.read',
] as const;
export const appBinding = (config: ShopifyConfig) =>
  `${config.environment}:${config.clientId}`;
export function validMac(
  secret: string,
  message: string | Buffer,
  signature: string,
  encoding: 'hex' | 'base64',
) {
  const expected = createHmac('sha256', secret).update(message).digest();
  const supplied = Buffer.from(signature, encoding);
  return (
    supplied.length === expected.length && timingSafeEqual(supplied, expected)
  );
}
export function callbackParams(query: string, secret: string) {
  const params = new URLSearchParams(query);
  if ([...params.keys()].some((key) => params.getAll(key).length !== 1))
    throw new Error('Invalid callback');
  const signature = params.get('hmac') ?? '';
  params.delete('hmac');
  const message = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  if (
    !/^[a-f0-9]{64}$/.test(signature) ||
    !validMac(secret, message, signature, 'hex')
  )
    throw new Error('Invalid callback');
  return params;
}
const tokenResponse = z.object({
  access_token: z.string().min(1).max(4096),
  refresh_token: z.string().min(1).max(4096),
  expires_in: z.number().int().positive().max(31536000),
  refresh_token_expires_in: z.number().int().positive().max(31536000),
  scope: z.string(),
});
export function createOAuthClient(
  config: ShopifyConfig,
  transport = globalThis.fetch,
  now = () => new Date(),
) {
  return {
    async token(
      shop: string,
      grant: { code: string } | { refresh_token: string },
    ): Promise<InstallationCredentials> {
      shopHostname.parse(shop);
      let response: Response;
      try {
        response = await transport(`https://${shop}/admin/oauth/access_token`, {
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.timeout(15000),
          headers: {
            'content-type': 'application/json',
            accept: 'application/json',
          },
          body: JSON.stringify({
            client_id: config.clientId,
            client_secret: config.clientSecret,
            ...grant,
            ...('code' in grant
              ? { expiring: 1 }
              : { grant_type: 'refresh_token' }),
          }),
        });
      } catch {
        throw new ConnectorError({
          code: 'transient',
          effect: 'none',
          retry: 'after_delay',
          retryAfterMs: 1000,
        });
      }
      if (!response.ok)
        throw new ConnectorError({
          code: [400, 401, 403].includes(response.status)
            ? 'authentication'
            : 'transient',
          effect: 'none',
          retry: 'never',
        });
      const result = tokenResponse.safeParse(await response.json());
      if (!result.success)
        throw new ConnectorError({
          code: 'transient',
          effect: 'none',
          retry: 'never',
        });
      const value = result.data;
      return {
        token: value.access_token,
        shopify: {
          app: appBinding(config),
          refreshToken: value.refresh_token,
          expiresAt: new Date(
            now().getTime() + value.expires_in * 1000,
          ).toISOString(),
          refreshExpiresAt: new Date(
            now().getTime() + value.refresh_token_expires_in * 1000,
          ).toISOString(),
          scopes: value.scope
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
        },
      };
    },
  };
}
