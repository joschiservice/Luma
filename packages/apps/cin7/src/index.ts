import type { AppDefinition } from '@luma/app-host';
import { type ConnectionProvider, ConnectorError } from '@luma/connections';
import { simulationTransport } from '@luma/connections/adapters';
import type { SimulationTransport } from '@luma/connections/composition';
import { createRequestPacer, type RequestPacer } from '@luma/connector-cin7';

import { createCin7Connector } from './infrastructure/adapter.js';
import {
  installationCredentials,
  installationInput,
  installationTarget,
} from './infrastructure/installation-validation.js';
import {
  createSaleCache,
  type SaleCache,
} from './infrastructure/sale-cache.js';
import {
  createProductUnits,
  type ProductUnits,
} from './infrastructure/units.js';
import { createInstallationVerifier } from './infrastructure/verifier.js';

export { createCin7Connector, createInstallationVerifier };

/**
 * Creates the Cin7 connector contribution. Adapters of one connection share its request
 * pacer, product units and recent sale details within this process.
 */
export function createCin7Provider(
  options: {
    fetch?: typeof globalThis.fetch | undefined;
    simulation?: SimulationTransport | undefined;
  } = {},
): ConnectionProvider {
  const shared = new Map<
    string,
    { pacer: RequestPacer; units: ProductUnits; sales: SaleCache }
  >();
  const stateOf = (tenantId: string, connectionId: string) => {
    const key = `${tenantId}:${connectionId}`;
    let state = shared.get(key);
    if (!state) {
      state = {
        pacer: createRequestPacer(),
        units: createProductUnits(),
        sales: createSaleCache(),
      };
      shared.set(key, state);
    }

    return state;
  };

  return {
    appId: 'cin7',
    provider: 'cin7',
    targets: ['cin7-core'],
    validate: (value) => installationInput.parse(value),
    credentials: (_target, value) => installationCredentials.parse(value),
    verify: createInstallationVerifier({
      ...options,
      pacer: (connection) => stateOf(connection.tenantId, connection.id).pacer,
    }),
    async build(context, id, capability, runtime) {
      const current = await runtime.installations.credential(
        context,
        id,
        capability,
      );
      const target = installationTarget.parse(current.connection.target);
      const fetch =
        simulationTransport(
          current.connection,
          runtime.simulation ?? options.simulation,
        ) ?? runtime.fetch;
      const state = stateOf(context.tenantId, id);

      return createCin7Connector({
        tenantId: context.tenantId,
        connectionId: id,
        recordObservations: runtime.recordObservations,
        ...(fetch ? { fetch } : {}),
        pacer: state.pacer,
        units: state.units,
        sales: state.sales,
        customers: current.connection.granted.includes('customers.read'),
        connection: {
          accountId: target.accountId,
          async applicationKey() {
            const latest = await runtime.installations.credential(
              context,
              id,
              capability,
            );
            // A paginated read stops when credentials change during it.
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
          },
        },
      });
    },
  };
}

/** Registers Cin7 Core connection setup and read capabilities. */
export function createApp(): AppDefinition {
  return {
    manifest: {
      id: 'cin7',
      name: 'Cin7 Core',
      description:
        'Connect Cin7 Core to read orders, fulfillments, credit notes, products, stock, customers, and purchasing.',
      version: '1.0.0',
      category: 'erp',
      ui: ['connections', 'settings'],
      connectionTypes: [{ kind: 'cin7-core', name: 'Cin7 Core' }],
      permissions: [],
      scopes: [
        'orders.read',
        'fulfillment.read',
        'inventory.read',
        'products.read',
        'customers.read',
        'returns.read',
        'procurement.read',
      ],
      slotAccess: {
        connections: 'connections.manage',
        settings: 'connections.manage',
      },
    },
    connector: createCin7Provider(),
  };
}
