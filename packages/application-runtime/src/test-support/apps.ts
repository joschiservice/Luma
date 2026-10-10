import { createCin7Provider } from '@luma/app-cin7';
import { createJtlProvider } from '@luma/app-jtl';
import {
  createShopifyOAuth,
  createShopifyProvider,
  type ShopifyConfig,
} from '@luma/app-shopify';
import type { InstallationDependencies } from '@luma/connections';
import {
  createInstallationService as service,
  createInstalledConnections as persistent,
  createInstalledRuntime as runtime,
  createInstalledShippingMethodEffects as effects,
  createSecretCipher,
} from '@luma/connections/composition';
import { requirePermission } from '@luma/identity';

/** Composes real provider contributions against injected fixture transports. */
export function providers(options: Parameters<typeof createJtlProvider>[0]) {
  return [
    createJtlProvider(options),
    createShopifyProvider(options),
    createCin7Provider(options),
  ];
}

/** Exercises provider validation with in-memory lifecycle repositories. */
export function createInstallationService(
  options: Parameters<typeof service>[0],
) {
  const all = providers({ jtlEndpoints: [] });
  const provider = (kind: string) => {
    const p = all.find((p) => p.targets.includes(kind));
    if (!p) throw new Error('Unknown provider');

    return p;
  };

  return service({
    ...options,
    validate: (input) => provider(input.target.kind).validate(input),
    validateCredentials: (target, input) =>
      provider(target.kind).credentials(target, input),
  });
}

/** Builds a fixture runtime with both provider contributions. */
export function createInstalledRuntime(
  options: Omit<Parameters<typeof runtime>[0], 'providers'> &
    Parameters<typeof createJtlProvider>[0],
) {
  return runtime({ ...options, providers: providers(options) });
}

/** Builds fixture shipping effects through the installed capability runtime. */
export function createInstalledShippingMethodEffects(
  options: Parameters<typeof createInstalledRuntime>[0],
  binding: Parameters<typeof effects>[1],
) {
  return effects({ ...options, providers: providers(options) }, binding);
}

/** Probes real provider adapters with fixture transports. */
export function createInstallationVerifier(
  options: Parameters<typeof createJtlProvider>[0],
): InstallationDependencies['verify'] {
  const all = providers(options);

  return (connection, credentials) => {
    const p = all.find((p) => p.targets.includes(connection.target.kind));
    if (!p) throw new Error('Unknown provider');

    return p.verify(connection, credentials);
  };
}

/** Supplies OAuth refresh to persistence tests without an HTTP host. */
export function createInstalledConnections(
  db: Parameters<typeof persistent>[0],
  options: Parameters<typeof persistent>[1] & { shopify?: ShopifyConfig },
) {
  const oauth = options.shopify
    ? createShopifyOAuth(db, options.shopify, {
        cipher: createSecretCipher(options.activeKeyId, options.keys),
        refreshContext: options.refreshContext,
        verify: options.verify,
        authorize: async (context) =>
          requirePermission(context, 'connections.manage'),
      })
    : undefined;

  return persistent(db, {
    ...options,
    ...(oauth
      ? {
          refreshCredential: (context, id, target) =>
            target.kind === 'shopify'
              ? oauth.credential(context, id)
              : Promise.resolve(),
        }
      : {}),
  });
}
