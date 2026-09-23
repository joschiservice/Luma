import type { TenantContext } from '@luma/identity';

import type { InstallationCredentials } from '../domain/installation.js';

export interface ShopifyOAuth {
  config: { webOrigin: string };
  start(
    context: TenantContext,
    input: unknown,
  ): Promise<{ authorizationUrl: string }>;
  callbackTenant(query: string): string;
  callback(
    context: TenantContext,
    query: string,
  ): Promise<'denied' | 'connected' | 'permissions'>;
  credential(
    context: TenantContext,
    id: string,
  ): Promise<InstallationCredentials>;
  uninstall(
    tenantId: string,
    id: string,
    body: Buffer,
    signature: string,
    shop: string,
    topic: string,
  ): Promise<void>;
}

export interface ShopifyAppConfig {
  clientId: string;
  clientSecret: string;
  environment: string;
  callbackUrl: string;
  webOrigin: string;
}
