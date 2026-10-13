import { createAppHost } from '@luma/app-catalog';
import { createApp as cin7, createCin7Provider } from '@luma/app-cin7';
import { createApp as gmail, createGmailProvider } from '@luma/app-gmail';
import { createApp as jtl, createJtlProvider } from '@luma/app-jtl';
import { createApp as shopify, createShopifyProvider } from '@luma/app-shopify';
import {
  createApp as starshipit,
  createStarshipitProvider,
} from '@luma/app-starshipit';
import {
  createInstalledMessageRuntime as mailboxes,
  createInstalledPurchaseOrderRuntime as purchaseOrders,
  createInstalledReturnRuntime as returns,
  createInstalledRuntime as runtime,
  createInstalledShippingMethodEffects as effects,
} from '@luma/connections/composition';

/** Composes every adapter for local simulator fixtures, in the order of `factories`. */
function fixtureProviders(options) {
  return [
    createJtlProvider({ ...options, jtlEndpoints: options.jtlEndpoints ?? [] }),
    createShopifyProvider(options),
    createCin7Provider(options),
    createStarshipitProvider(options),
    // Token-based mailbox access through the simulator; no Google OAuth or push in fixtures.
    createGmailProvider({
      ...(options.simulation ? { simulation: options.simulation } : {}),
      ...(options.fetch ? { fetch: options.fetch } : {}),
    }),
  ];
}

/** Verifies fixture accounts through the provider that owns their target. */
export function createInstallationVerifier(options) {
  const providers = fixtureProviders(options);

  return (connection, credentials) =>
    providers
      .find((p) => p.targets.includes(connection.target.kind))
      .verify(connection, credentials);
}

/** Creates a real app lifecycle around local synthetic provider transports. */
export function createInstalledConnections(db, options) {
  const providers = fixtureProviders(options);
  const host = createAppHost(db, {
    ...options,
    env: options.env ?? {},
    factories: [jtl, shopify, cin7, starshipit, gmail].map(
      (factory, index) => (context) => {
        const definition = factory(context);

        return {
          ...definition,
          connector: {
            ...(factory === starshipit
              ? definition.connector
              : providers[index]),
            ...(options.verify ? { verify: options.verify } : {}),
          },
        };
      },
    ),
  });

  return {
    ...host.connections,
    apps: host.apps,
    registry: host.registry,
    decisionSources: host.decisionSources,
    providerCatalog: host.providerCatalog,
  };
}

/** Builds a simulator capability runtime with explicit provider contributions. */
export function createInstalledRuntime(options) {
  return runtime({
    ...options,
    providers: options.providers ?? fixtureProviders(options),
  });
}

/** Builds simulator effects with explicit provider contributions. */
export function createInstalledShippingMethodEffects(options, binding) {
  return effects(
    { ...options, providers: options.providers ?? fixtureProviders(options) },
    binding,
  );
}

/** Builds simulator purchase-order reads and submission effects with explicit providers. */
export function createInstalledPurchaseOrderRuntime(options) {
  return purchaseOrders({
    ...options,
    providers: options.providers ?? fixtureProviders(options),
  });
}

/** Builds simulator mailbox reads and reply send effects with explicit providers. */
export function createInstalledMessageRuntime(options) {
  return mailboxes({
    ...options,
    providers: options.providers ?? fixtureProviders(options),
  });
}

/** Builds simulator return reads and return-creation effects with explicit providers. */
export function createInstalledReturnRuntime(options) {
  return returns({
    ...options,
    providers: options.providers ?? fixtureProviders(options),
  });
}
