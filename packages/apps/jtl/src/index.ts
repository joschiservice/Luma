import type { AppDefinition, AppFactoryContext } from '@luma/app-host';
import {
  type ConnectionProvider,
  ConnectorError,
  type InstallationCapability,
} from '@luma/connections';
import {
  boundedReadTransport,
  simulationTransport,
} from '@luma/connections/adapters';
import { hasPermission } from '@luma/identity';
import { z } from 'zod';

import { type JtlEndpoint, readJtlEndpoints } from './config.js';
import { jtlPermissions } from './domain/permissions.js';
import { createJtlConnector } from './infrastructure/adapter.js';
import { approvedJtlFetch } from './infrastructure/approved-jtl-fetch.js';
import {
  installationCredentials,
  installationInput,
  installationTarget,
} from './infrastructure/installation-validation.js';
import { createInstallationVerifier } from './infrastructure/verifier.js';

export { createJtlConnector };

export { createInstallationVerifier };

export type { JtlEndpoint };

// Each write capability may send exactly one HTTP method through the pinned on-premise transport.
const writeMethods: Partial<
  Record<
    InstallationCapability,
    {
      writeMethod?: 'PATCH' | 'POST';
      writeMethods?: readonly ('PATCH' | 'POST' | 'DELETE')[];
    }
  >
> = {
  'orders.shipping-method.write': { writeMethod: 'PATCH' },
  'purchase-orders.submit': { writeMethod: 'POST' },
  'purchase-orders.revise': { writeMethods: ['PATCH', 'POST', 'DELETE'] },
  'returns.create': { writeMethod: 'POST' },
};

const writeReads: Partial<
  Record<InstallationCapability, InstallationCapability>
> = {
  'orders.shipping-method.write': 'orders.shipping-method.read',
  'purchase-orders.submit': 'purchase-orders.read',
  'purchase-orders.revise': 'purchase-orders.read',
  'returns.create': 'returns.created.read',
  'returns.restock': 'returns.settlement.quote.read',
};

/** Creates the JTL connector contribution with deployment-approved network destinations. */
export function createJtlProvider(options: {
  jtlEndpoints: readonly JtlEndpoint[];
  purchaseOrderChangesEnabled?: (tenantId: string) => Promise<boolean>;
  purchasingTermsEnabled?: (tenantId: string) => Promise<boolean>;
  fetch?: typeof globalThis.fetch;
  simulation?: Parameters<typeof createInstallationVerifier>[0]['simulation'];
  approveJtlEndpoint?: (
    context: Parameters<ConnectionProvider['build']>[0],
    baseUrl: string,
  ) => Promise<void>;
}): ConnectionProvider {
  return {
    appId: 'jtl',
    provider: 'jtl',
    targets: ['jtl-cloud', 'jtl-onprem'],
    validate: (value) => installationInput.parse(value),
    credentials(target, value) {
      const credentials = installationCredentials.parse(value);
      if (
        installationTarget.parse(target).kind === 'jtl-onprem' &&
        !credentials.challengeCode
      )
        throw new Error('Challenge code required');

      return credentials;
    },
    verify: createInstallationVerifier(options),
    async build(context, id, capability, runtime) {
      const current = await runtime.installations.credential(
        context,
        id,
        capability,
      );
      const target = installationTarget.parse(current.connection.target);
      const simulated = simulationTransport(
        current.connection,
        runtime.simulation ?? options.simulation,
      );
      const token = async () => {
        if (target.kind === 'jtl-onprem' && !simulated)
          await options.approveJtlEndpoint?.(context, target.baseUrl);
        // A write re-reads current provider state, so it also needs its read grant.
        const read = writeReads[capability];
        if (read) await runtime.installations.credential(context, id, read);
        if (capability === 'returns.restock')
          await runtime.installations.credential(
            context,
            id,
            'returns.settlement.proof.read',
          );
        const latest = await runtime.installations.credential(
          context,
          id,
          capability,
        );
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
      let fetch = simulated ?? runtime.fetch;
      if (target.kind === 'jtl-onprem' && !simulated) {
        fetch = async (...args: Parameters<typeof globalThis.fetch>) => {
          const endpoint = options.jtlEndpoints.find(
            (e) =>
              e.tenantId === context.tenantId && e.baseUrl === target.baseUrl,
          );
          if (!endpoint)
            throw new ConnectorError({
              code: 'permission_denied',
              effect: 'none',
              retry: 'never',
            });

          return approvedJtlFetch(endpoint, writeMethods[capability])(...args);
        };
      }

      if (runtime.readBounds) {
        if (!capability.endsWith('.read'))
          throw new ConnectorError({
            code: 'invalid_input',
            effect: 'none',
            retry: 'never',
          });
        fetch = boundedReadTransport(
          fetch ?? globalThis.fetch,
          runtime.readBounds,
        );
      }

      return createJtlConnector({
        tenantId: context.tenantId,
        connectionId: id,
        recordObservations: runtime.recordObservations,
        purchasingTerms:
          current.connection.granted.includes('suppliers.read') &&
          hasPermission(context, 'procurement.read') &&
          ((await options.purchasingTermsEnabled?.(context.tenantId)) ?? false),
        ...(fetch ? { fetch } : {}),
        shippingMethodActions: true,
        purchaseOrderActions: true,
        purchaseOrderRevisions:
          (await options.purchaseOrderChangesEnabled?.(context.tenantId)) ??
          false,
        returnActions: true,
        settlementActions: !!simulated,
        customers: current.connection.granted.includes('customers.read'),
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
                challengeCode: z
                  .string()
                  .parse(current.credentials.challengeCode),
                apiKey: token,
              },
      });
    },
  };
}

/** Registers JTL connection setup and commerce capabilities. */
export function createApp(context: AppFactoryContext): AppDefinition {
  return {
    manifest: {
      id: 'jtl',
      name: 'JTL',
      description:
        'Connect JTL Cloud or JTL-Wawi to read commerce data, correct shipping methods, send approved purchase orders, and create approved returns.',
      version: '1.0.0',
      category: 'erp',
      ui: ['connections', 'settings'],
      connectionTypes: [
        { kind: 'jtl-cloud', name: 'JTL Cloud' },
        { kind: 'jtl-onprem', name: 'JTL-Wawi on-premise' },
      ],
      permissions: [
        {
          key: jtlPermissions.restock,
          label: 'Restock inspected returns',
          description:
            'Request approval for and restock only inspected resale units in a Wawi warehouse.',
          consequential: true,
        },
        {
          key: jtlPermissions.purchaseOrders,
          label: 'Send purchase orders to JTL',
          description:
            'Propose, approve, and send purchase orders to JTL. Approving also needs the permission to approve changes.',
          consequential: true,
        },
        {
          key: jtlPermissions.shippingMethod,
          label: 'Change JTL shipping methods',
          description:
            'Propose, approve, and apply shipping method corrections to JTL orders. Approving also needs the permission to approve changes.',
          consequential: true,
        },
        {
          key: jtlPermissions.returns,
          label: 'Create returns in JTL',
          description:
            'Propose, approve, and create returns in JTL for return cases. Approving also needs the permission to approve changes.',
          consequential: true,
        },
      ],
      scopes: [
        'orders.read',
        'fulfillment.read',
        'inventory.read',
        'products.read',
        'customers.read',
        'procurement.read',
        'actions.propose',
        'actions.execute',
      ],
      slotAccess: {
        connections: 'connections.manage',
        settings: 'connections.manage',
      },
    },
    connector: createJtlProvider({
      jtlEndpoints: readJtlEndpoints(context.env),
      purchaseOrderChangesEnabled: (tenantId) =>
        context.featureEnabled?.(tenantId, 'purchasing-order-changes') ??
        Promise.resolve(false),
      purchasingTermsEnabled: (tenantId) =>
        context.featureEnabled?.(tenantId, 'supplier-purchasing-terms') ??
        Promise.resolve(false),
    }),
  };
}
