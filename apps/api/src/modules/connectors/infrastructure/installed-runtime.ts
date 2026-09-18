import type { TenantContext } from '../../identity/index.js';
import type { InstallationService } from '../application/installations.js';
import { createCapabilityRuntime } from '../application/capabilities.js';
import type {
  CapabilityDependencies,
  ConnectorConnection,
} from '../application/capabilities.js';
import type { InstallationCapability } from '../domain/installation.js';
import type { CapabilityHandler } from '../application/capabilities.js';
import { ConnectorError } from '../domain/capabilities.js';
import { createShopifyConnector } from './shopify/adapter.js';
import type { ShopifyEvidence } from './shopify/adapter.js';
import { createJtlConnector } from './jtl/adapter.js';
import type { JtlEvidence } from './jtl/adapter.js';

export interface InstalledRuntimeOptions {
  installations: InstallationService;
  record: CapabilityDependencies['record'];
  recordObservations(evidence: ShopifyEvidence | JtlEvidence): Promise<void>;
  /** Enforce deployment-specific network allowlists before any JTL on-premise request. */
  approveJtlEndpoint(context: TenantContext, baseUrl: string): Promise<void>;
  fetch?: typeof globalThis.fetch;
}
export function createInstalledRuntime(options: InstalledRuntimeOptions) {
  const { installations } = options;
  return createCapabilityRuntime({
    record: options.record,
    async resolve(context, id) {
      const connection = (await installations.list(context)).find(
        (c) => c.id === id,
      );
      if (!connection || connection.status !== 'active') return null;
      const capabilities: ConnectorConnection['capabilities'] = {};
      for (const capability of connection.permissions) {
        if (!connection.granted.includes(capability)) continue;
        const build = async (cap: InstallationCapability) => {
          const current = await installations.credential(context, id, cap);
          const target = current.connection.target;
          const token = async () => {
            if (target.kind === 'jtl-onprem')
              await options.approveJtlEndpoint(context, target.baseUrl);
            if (cap === 'orders.shipping-method.write')
              await installations.credential(
                context,
                id,
                'orders.shipping-method.read',
              );
            const latest = await installations.credential(context, id, cap);
            if (
              latest.connection.credentialVersion !==
              current.connection.credentialVersion
            )
              throw new ConnectorError({
                code: 'conflict',
                effect: 'none',
                retry: 'never',
              });
            return latest.credentials.token;
          };
          const common = {
            tenantId: context.tenantId,
            connectionId: id,
            recordObservations: options.recordObservations,
            ...(options.fetch ? { fetch: options.fetch } : {}),
          };
          if (target.kind === 'shopify')
            return createShopifyConnector({
              ...common,
              shop: target.shop,
              accessToken: token,
            });
          return createJtlConnector({
            ...common,
            shippingMethodActions: true,
            connection:
              target.kind === 'jtl-cloud'
                ? {
                    kind: 'cloud',
                    jtlTenantId: target.jtlTenantId,
                    accessToken: token,
                  }
                : {
                    kind: 'onprem',
                    baseUrl: target.baseUrl,
                    appId: target.appId,
                    appVersion: target.appVersion,
                    challengeCode: current.credentials.challengeCode!,
                    apiKey: token,
                  },
          });
        };
        // Adapter parsing and descriptors stay authoritative; each invocation resolves fresh credentials.
        let adapter: ConnectorConnection;
        try {
          adapter = await build(capability);
        } catch (error) {
          // Lifecycle changes can invalidate the snapshot before credentials resolve.
          if (
            error instanceof ConnectorError &&
            (error.failure.code === 'unavailable' ||
              error.failure.code === 'permission_denied')
          )
            return null;
          throw error;
        }
        if (
          capability === 'orders.shipping-method.write' &&
          (!connection.permissions.includes('orders.shipping-method.read') ||
            !connection.granted.includes('orders.shipping-method.read'))
        )
          continue;
        const handler = adapter.capabilities[capability] as
          CapabilityHandler<InstallationCapability> | undefined;
        if (!handler) continue;
        Object.assign(capabilities, {
          [capability]: {
            ...handler,
            run: async (
              invocation: Parameters<typeof handler.run>[0],
              input: Parameters<typeof handler.run>[1],
            ) => {
              const fresh = await build(capability);
              const current = fresh.capabilities[capability] as
                CapabilityHandler<InstallationCapability> | undefined;
              if (!current)
                throw new ConnectorError({
                  code: 'unsupported_capability',
                  effect: 'none',
                  retry: 'never',
                });
              return current.run(invocation, input);
            },
          },
        });
      }
      return {
        tenantId: context.tenantId,
        id,
        provider: connection.target.kind === 'shopify' ? 'shopify' : 'jtl',
        status: 'active',
        adapterVersion:
          connection.target.kind === 'shopify' ? 'shopify/0' : 'jtl/0',
        mechanism: 'api',
        executor: {
          kind: 'connector',
          id: connection.target.kind === 'shopify' ? 'shopify/0' : 'jtl/0',
        },
        capabilities,
      };
    },
  });
}
