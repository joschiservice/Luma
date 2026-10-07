import type {
  InstallationService,
  InstalledConnection,
} from '@luma/connections';
import type { TenantContext } from '@luma/identity';
import { IdentityError } from '@luma/identity';

import {
  type CustomerSearch,
  recordCapability,
  recordInput,
  type ShopifyRecordDetail,
  type ShopifyRecordKind,
} from '../domain/records.js';

/** Reads linked records with current tenant, installation and capability checks on every provider request. */
export function createRecordService(options: {
  installations: Pick<InstallationService, 'credential'>;
  requireInstalled(context: TenantContext): Promise<number>;
  /**
   * Requires the person and the app's granted scopes to allow reading this kind of record;
   * see `recordPermission`.
   */
  authorize(context: TenantContext, kind: ShopifyRecordKind): Promise<void>;
  protectedCustomerDataApproved: boolean;
  /** Enable only when Shopify approves name, email and phone access for this deployment. */
  protectedCustomerContactApproved?: boolean;
  /** Creates a provider reader using the authorized connection and current token resolver. */
  reader(options: {
    tenantId: string;
    connectionId: string;
    /** The authorized connection, so composition can route simulated ones to the simulator. */
    connection: InstalledConnection;
    shop: string;
    protectedCustomerDataApproved: boolean;
    /** Enable only when Shopify approves name, email and phone access for this deployment. */
    protectedCustomerContactApproved?: boolean;
    accessToken(): Promise<string>;
  }): (
    kind: ShopifyRecordKind,
    id?: string,
    cursor?: string,
    search?: CustomerSearch,
  ) => Promise<ShopifyRecordDetail>;
}) {
  return async (context: TenantContext, input: unknown) => {
    const parsed = recordInput.safeParse(input);
    if (!parsed.success)
      throw new IdentityError(
        422,
        'CONFLICT',
        'Choose a valid Shopify record type and ID.',
      );
    const { connectionId, kind, id, cursor, search } = parsed.data;
    await options.authorize(context, kind);
    const capability = recordCapability(kind);
    const credential = async () => {
      const version = await options.requireInstalled(context);
      const current = await options.installations.credential(
        context,
        connectionId,
        capability,
      );
      if (
        current.connection.appId !== 'shopify' ||
        current.connection.provider !== 'shopify' ||
        current.connection.appInstallationVersion !== version
      )
        throw new IdentityError(
          404,
          'NOT_FOUND',
          'Shopify connection not found',
        );

      return current;
    };
    const current = await credential();
    const shop = current.connection.target.shop;
    if (current.connection.target.kind !== 'shopify' || !shop)
      throw new IdentityError(404, 'NOT_FOUND', 'Shopify connection not found');
    const reader = options.reader({
      tenantId: context.tenantId,
      connectionId,
      connection: current.connection,
      shop,
      protectedCustomerDataApproved: options.protectedCustomerDataApproved,
      protectedCustomerContactApproved:
        options.protectedCustomerContactApproved === true,
      accessToken: async () => {
        const fresh = await credential();
        if (fresh.connection.target.shop !== shop)
          throw new IdentityError(
            409,
            'CONFLICT',
            'Connection changed; reload and retry',
          );

        return fresh.credentials.token;
      },
    });

    return reader(kind, id, cursor, search);
  };
}
