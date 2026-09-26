import { IdentityError } from '@luma/identity';

import type {
  CapabilityDependencies,
  CapabilityHandler,
  ConnectorConnection,
} from '../../application/capabilities.js';
import { createCapabilityRuntime } from '../../application/capabilities.js';
import type {
  ConnectionProvider,
  ProviderRuntimeOptions,
} from '../../application/provider.js';
import {
  createShippingMethodEffects,
  type ShippingMethodEffectBinding,
} from '../../application/shipping-method-effects.js';
import { ConnectorError } from '../../domain/capabilities.js';
import type { InstallationCapability } from '../../domain/installation.js';

export interface InstalledRuntimeOptions extends ProviderRuntimeOptions {
  providers: readonly ConnectionProvider[];
  record: CapabilityDependencies['record'];
}

function installedRuntime(options: InstalledRuntimeOptions) {
  return createCapabilityRuntime({
    record: options.record,
    async resolve(context, id) {
      const connection = (await options.installations.list(context)).find(
        (c) => c.id === id,
      );
      if (!connection || connection.status !== 'active') return null;
      const provider = options.providers.find((p) =>
        p.targets.includes(connection.target.kind),
      );
      if (!provider) return null;
      const capabilities: ConnectorConnection['capabilities'] = {};
      let descriptor: ConnectorConnection | undefined;
      for (const capability of connection.permissions) {
        if (!connection.granted.includes(capability)) continue;
        const build = async () => {
          await options.installations.credential(context, id, capability);

          return provider.build(context, id, capability, options);
        };
        let adapter: ConnectorConnection;
        try {
          adapter = await build();
        } catch (error) {
          if (
            error instanceof IdentityError &&
            [404, 409].includes(error.statusCode)
          )
            return null;
          if (
            error instanceof ConnectorError &&
            ['unavailable', 'permission_denied'].includes(error.failure.code)
          )
            return null;
          throw error;
        }
        descriptor = adapter;
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
              const fresh = await build();
              const current = fresh.capabilities[capability] as typeof handler;
              if (!current)
                throw new ConnectorError({
                  code: 'unsupported_capability',
                  effect: 'none',
                  retry: 'never',
                });
              const snapshot = await options.installations.credential(
                context,
                id,
                capability,
              );
              try {
                return await current.run(invocation, input);
              } catch (error) {
                if (
                  provider.recordAccessFailures &&
                  error instanceof ConnectorError &&
                  (error.failure.code === 'authentication' ||
                    error.failure.code === 'permission_denied')
                ) {
                  await options.installations.recordFailure(
                    context,
                    id,
                    snapshot.connection.credentialVersion,
                    error.failure.code,
                  );
                }
                throw error;
              }
            },
          },
        });
      }

      return descriptor ? { ...descriptor, capabilities } : null;
    },
  });
}

/** Resolves only available app capabilities and checks current installation state on every invocation. */
export function createInstalledRuntime(options: InstalledRuntimeOptions) {
  const runtime = installedRuntime(options);

  return Object.freeze({ read: runtime.read, discover: runtime.discover });
}

/** Supplies shipping-method effects through the same installation-gated runtime. */
export function createInstalledShippingMethodEffects(
  options: InstalledRuntimeOptions,
  binding: ShippingMethodEffectBinding,
) {
  return createShippingMethodEffects(installedRuntime(options), binding);
}
