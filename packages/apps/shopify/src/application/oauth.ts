import type { InstallationCredentials } from '@luma/connections';
import type { TenantContext } from '@luma/identity';

export interface ShopifyOAuth {
  config: { webOrigin: string };
  /** Reports deployment approvals and the last recorded grants without exposing credentials. */
  access(
    context: TenantContext,
    connectionId?: string,
  ): Promise<{
    customerDataApproved: boolean;
    allOrdersApproved: boolean;
    requestedScopes: string[];
    grantedScopes: string[] | null;
    missingScopes: string[];
  }>;
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
  /** Reconciles a signed scope-change notification against current Shopify grants. */
  scopesUpdated(
    tenantId: string,
    id: string,
    body: Buffer,
    signature: string,
    shop: string,
    topic: string,
  ): Promise<void>;
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
  protectedCustomerDataApproved?: boolean;
  allOrdersApproved?: boolean;
  clientId: string;
  clientSecret: string;
  environment: string;
  callbackUrl: string;
  webOrigin: string;
}
