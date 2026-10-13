import { randomUUID } from 'node:crypto';

import type { AppDefinition, AppFactoryContext } from '@luma/app-host';
import {
  type CapabilityHandler,
  type ConnectionProvider,
  ConnectorError,
  type InstallationCapability,
} from '@luma/connections';
import { simulationTransport } from '@luma/connections/adapters';
import {
  createInstallationRepository,
  createInstallationService,
} from '@luma/connections/composition';
import { createClient, parse } from '@luma/connector-starshipit';
import * as s from '@luma/connector-starshipit/schemas';
import type { TenantContext } from '@luma/identity';

import { createStarshipitConnector } from './infrastructure/adapter.js';
import {
  installationCredentials,
  installationInput,
  installationTarget,
} from './infrastructure/installation-validation.js';
import { registerStarshipitRoutes } from './routes.js';
import { createStarshipitUpdates } from './updates.js';

export { createStarshipitConnector };

/** Fixed-host shipping provider with refreshed tenant credentials and conservative confirmed grants. */
export function createStarshipitProvider(
  context: Pick<AppFactoryContext, 'simulation' | 'featureEnabled'>,
  update?: (
    tenant: TenantContext,
    connectionId: string,
  ) => CapabilityHandler<'orders.quantity.update'>,
): ConnectionProvider {
  const enabled = async (tenantId: string) => {
    if (!(await context.featureEnabled?.(tenantId, 'starshipit-fulfillment')))
      throw new ConnectorError({
        code: 'unavailable',
        effect: 'none',
        retry: 'never',
      });
  };

  return {
    appId: 'starshipit',
    provider: 'starshipit',
    targets: ['starshipit'],
    validate: (value) => installationInput.parse(value),
    credentials: (_target, value) => installationCredentials.parse(value),
    async verify(connection, credentials) {
      await enabled(connection.tenantId);
      const secret = installationCredentials.parse(credentials);
      const fetch = simulationTransport(connection, context.simulation);
      const client = createClient({
        credentials: async () => secret,
        ...(fetch ? { fetch } : {}),
      });
      parse(
        s.list,
        await client.read(
          'orders',
          new URLSearchParams({
            status: 'Unshipped',
            page_number: '1',
            page_size: '1',
          }),
        ),
      );
      // API keys identify their account; Starshipit has no documented account-ID echo or scope endpoint.
      // A successful read cannot establish live write permission. Confirmed synthetic grants are explicit.
      const granted: InstallationCapability[] = connection.permissions.filter(
        (capability) =>
          capability === 'orders.read' || capability === 'fulfillment.read',
      );
      if (
        fetch &&
        connection.permissions.includes('orders.quantity.update') &&
        (await context.featureEnabled?.(
          connection.tenantId,
          'starshipit-actions',
        ))
      )
        granted.push('orders.quantity.update');

      return granted;
    },
    async build(tenant, id, capability, runtime) {
      await enabled(tenant.tenantId);
      const current = await runtime.installations.credential(
        tenant,
        id,
        capability,
      );
      installationTarget.parse(current.connection.target);
      const fetch =
        simulationTransport(
          current.connection,
          runtime.simulation ?? context.simulation,
        ) ?? runtime.fetch;

      const connector = createStarshipitConnector({
        tenantId: tenant.tenantId,
        connectionId: id,
        recordObservations: runtime.recordObservations,
        ...(fetch ? { fetch } : {}),
        credentials: async () => {
          await enabled(tenant.tenantId);
          const latest = await runtime.installations.credential(
            tenant,
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

          return installationCredentials.parse(latest.credentials);
        },
      });
      if (
        update &&
        current.connection.granted.includes('orders.quantity.update') &&
        (await context.featureEnabled?.(tenant.tenantId, 'starshipit-actions'))
      )
        connector.capabilities['orders.quantity.update'] = update(tenant, id);

      return connector;
    },
  };
}

/** Registers read visibility and the separately governed downstream quantity correction. */
export function createApp(context: AppFactoryContext): AppDefinition {
  const connector = createStarshipitProvider(context, (tenant, id) =>
    updates.handler(tenant, id),
  );
  const installations = createInstallationService({
    repository: createInstallationRepository(context.database),
    cipher: context.cipher,
    refreshContext: context.refreshContext,
    verify: connector.verify,
    id: randomUUID,
    now: () => new Date(),
  });
  const updates = createStarshipitUpdates(context, installations);

  return {
    manifest: {
      id: 'starshipit',
      name: 'Starshipit',
      description:
        'Read shipping orders and carrier tracking, and review unshipped order corrections.',
      version: '1.0.0',
      category: 'utility',
      ui: ['connections', 'settings', 'record'],
      connectionTypes: [{ kind: 'starshipit', name: 'Starshipit' }],
      permissions: [
        {
          key: 'starshipit:order_update.run',
          label: 'Correct unshipped Starshipit orders',
          description:
            'Propose and apply approved quantity corrections before labels are created.',
          consequential: true,
        },
      ],
      scopes: [
        'orders.read',
        'fulfillment.read',
        'actions.propose',
        'actions.execute',
      ],
      slotAccess: {
        connections: 'connections.manage',
        settings: 'connections.manage',
        record: 'orders.read',
      },
      actionAccess: { 'orders.quantity.update': 'starshipit:order_update.run' },
      decisionAccess: {
        order_edit: {
          view: 'starshipit:order_update.run',
          respond: 'starshipit:order_update.run',
        },
      },
    },
    connector,
    decisions: updates.decisions,
    registerHttp(server) {
      registerStarshipitRoutes(server, updates, context);
    },
  };
}
