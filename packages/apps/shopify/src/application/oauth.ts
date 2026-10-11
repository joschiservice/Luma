import type { shopifyAccessSchema } from '@luma/api-contract';
import type { InstallationCredentials } from '@luma/connections';
import type { TenantContext } from '@luma/identity';
import type { z } from 'zod';

export interface ShopifyOAuth {
  config: { webOrigin: string };
  /** Reports deployment approvals and the last recorded grants without exposing credentials. */
  access(
    context: TenantContext,
    connectionId?: string,
  ): Promise<z.infer<typeof shopifyAccessSchema>>;
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
  /**
   * Verifies a signed record-change notification and durably schedules fresh reads for the
   * affected record types. The notification body is never imported.
   */
  changed(
    tenantId: string,
    id: string,
    body: Buffer,
    signature: string,
    shop: string,
    topic: string,
    eventId: string,
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
