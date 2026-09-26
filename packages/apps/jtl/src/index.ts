import type { AppDefinition, AppFactoryContext } from '@luma/app-host';
import { type ConnectionProvider, ConnectorError } from '@luma/connections';
import { simulationTransport } from '@luma/connections/adapters';
import { z } from 'zod';

import { type JtlEndpoint, readJtlEndpoints } from './config.js';
import { createJtlConnector } from './infrastructure/adapter.js';
import { approvedJtlFetch } from './infrastructure/approved-jtl-fetch.js';
import {
  installationCredentials,
  installationInput,
  installationTarget,
} from './infrastructure/installation-validation.js';
import { createInstallationVerifier } from './infrastructure/verifier.js';

export { createJtlConnector };

export type {
  JtlConnectorOptions,
  JtlEvidence,
} from './infrastructure/adapter.js';

export type { JtlConnection } from '@luma/connector-jtl';

export { readJtlEndpoints, createInstallationVerifier };

export type { JtlEndpoint };

/** Creates the JTL connector contribution with deployment-approved network destinations. */
export function createJtlProvider(options: {
  jtlEndpoints: readonly JtlEndpoint[];
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
        runtime.simulation,
      );
      const token = async () => {
        if (target.kind === 'jtl-onprem' && !simulated)
          await options.approveJtlEndpoint?.(context, target.baseUrl);
        if (capability === 'orders.shipping-method.write')
          await runtime.installations.credential(
            context,
            id,
            'orders.shipping-method.read',
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

          return approvedJtlFetch(endpoint, {
            allowWrites: capability === 'orders.shipping-method.write',
          })(...args);
        };
      }

      return createJtlConnector({
        tenantId: context.tenantId,
        connectionId: id,
        recordObservations: runtime.recordObservations,
        ...(fetch ? { fetch } : {}),
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
        'Connect JTL Cloud and JTL-Wawi to read commerce data and manage permitted shipping corrections.',
      version: '1.0.0',
      category: 'erp',
      ui: ['connections', 'settings'],
      connectionTypes: [
        { kind: 'jtl-cloud', name: 'JTL Cloud' },
        { kind: 'jtl-onprem', name: 'JTL-Wawi on-premise' },
      ],
    },
    connector: createJtlProvider({
      jtlEndpoints: readJtlEndpoints(context.env),
    }),
  };
}
