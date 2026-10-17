import { randomUUID } from 'node:crypto';

import type {
  CapabilityHandler,
  ConnectionProvider,
  ConnectorConnection,
  EffectIntent,
  InstallationCapability,
  InstalledConnection,
} from '@luma/connections';
import { builtInMembership, makeTenantContext } from '@luma/identity';
import { describe, expect, it } from 'vitest';

import type { ApplicationOptions } from './application.js';
import { type EffectFamily, resolvableEffects } from './application.js';
import { applicationOptionsFor } from './application-options.js';

const tenantId = randomUUID();
const connectionId = randomUUID();
const userId = randomUUID();
const context = makeTenantContext(
  { userId, sessionId: randomUUID() },
  {
    id: tenantId,
    name: 'Test',
    slug: 'test',
    dataRegion: 'AU',
    status: 'active',
  },
  builtInMembership(
    { id: randomUUID(), organizationId: tenantId, userId },
    'owner',
  ),
  randomUUID(),
);
const writes = [
  'purchase-orders.submit',
  'messages.send',
  'returns.refund',
] as const satisfies InstallationCapability[];
const connection: InstalledConnection = {
  id: connectionId,
  tenantId,
  label: 'Synthetic provider',
  target: { kind: 'synthetic' },
  permissions: [...writes],
  granted: [...writes],
  status: 'active',
  version: 1,
  credentialVersion: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};
const handler = {
  descriptor: {
    version: '0',
    minimumRisk: 'high',
    idempotency: 'provider_key',
    retry: { maxAttempts: 1, initialDelayMs: 0 },
  },
  parseInput: (input: unknown) => input,
  parseOutput: (output: unknown) => output,
  run: async () => ({ evidenceRefs: [], providerRequestId: null }),
} as unknown as CapabilityHandler<'messages.send'>;
const provider: ConnectionProvider = {
  appId: 'synthetic',
  provider: 'synthetic',
  targets: ['synthetic'],
  validate: (input: unknown) => input,
  credentials: () => ({ token: 'synthetic' }),
  verify: async () => undefined,
  build: async (): Promise<ConnectorConnection> => ({
    tenantId,
    id: connectionId,
    provider: 'synthetic',
    status: 'active',
    adapterVersion: 'synthetic/1',
    mechanism: 'api',
    executor: { kind: 'connector', id: 'synthetic/1' },
    capabilities: Object.fromEntries(writes.map((c) => [c, handler])),
  }),
} as unknown as ConnectionProvider;

/** An app host as each process creates it from the same installed apps and connections. */
function host() {
  const installations = {
    list: async () => [connection],
    credential: async () => ({
      connection,
      credentials: { token: 'synthetic' },
    }),
  };

  return {
    connections: installations,
    registry: {
      providers: () => [provider],
      workflowSources: () => [],
      actionPermission: () => null,
    },
    providerCatalog: { get: () => undefined },
    connectionEnvironment: async () => ({
      environment: 'unknown',
      provenance: null,
    }),
    decisionSources: () => [],
  } as unknown as Parameters<typeof applicationOptionsFor>[0];
}

const enabled: ApplicationOptions['execution'] = {
  kind: 'enabled',
  effects: { resolve: async () => null },
};
const internal: EffectFamily[] = [
  'adaptive_fields',
  'procurement',
  'supplier_follow_up',
];
const external: EffectFamily[] = [
  'purchase_order_submission',
  'purchase_order_change',
  'reply',
  'return_creation',
  'return_settlement',
  'return_exchange',
];

/** The options each process composes, as its runtime builder passes them. */
const runtimes = {
  api: { ...applicationOptionsFor(host()), execution: enabled },
  apiWithoutWorkflows: {
    ...applicationOptionsFor(host()),
    execution: { kind: 'disabled' } as const,
  },
  apiWithoutConnections: {
    ...applicationOptionsFor(host(), { providerRuntimes: false }),
    execution: enabled,
  },
  workflowWorker: { ...applicationOptionsFor(host()), execution: enabled },
  mailboxSync: { ...applicationOptionsFor(host()), execution: enabled },
  supplierFollowUp: { ...applicationOptionsFor(host()), execution: enabled },
  returnFollowUp: { ...applicationOptionsFor(host()), execution: enabled },
};

function intent(capability: string): EffectIntent {
  return {
    tenantId,
    connectionId,
    capability,
    capabilityVersion: '0',
    target: { kind: 'synthetic', id: randomUUID() },
    parameters: {},
    preconditions: {
      evidenceRefs: [],
      validUntil: new Date(Date.now() + 60_000).toISOString(),
    },
    expectedPostcondition: {},
  };
}

const binding = {
  map: async () => ({}) as never,
  checkPreconditions: async () => true,
  verify: async () => ({
    outcome: 'passed' as const,
    observationRefs: [],
    observedAt: new Date().toISOString(),
    evaluatorVersion: 'synthetic/1',
  }),
  storeReceipt: async () => 'synthetic-receipt',
};

/** Resolves each provider-write family through a runtime's installed provider runtimes. */
async function adapters(options: (typeof runtimes)['api']) {
  const submit = intent('purchase-orders.submit');
  const send = intent('messages.send');
  const refund = intent('returns.refund');

  return Promise.all([
    options
      .purchasing!.runtime.submissionEffects(binding)
      .resolve(context, submit),
    options.messaging!.sender!.sendEffects(binding).resolve(context, send),
    options
      .returns!.runtime.settlementEffects('returns.refund', binding)
      .resolve(context, refund),
  ]).then((found) =>
    found.map((adapter) => ({
      dispatchIdentity: adapter?.dispatchIdentity,
      mechanism: adapter?.mechanism,
      executor: adapter?.executor,
    })),
  );
}

describe('runtime effects', () => {
  it('pins the effect families each runtime resolves', () => {
    const families = Object.fromEntries(
      Object.entries(runtimes).map(([name, options]) => [
        name,
        [...resolvableEffects(options)].sort(),
      ]),
    );

    expect(families).toEqual({
      api: [...internal, ...external].sort(),
      apiWithoutWorkflows: [],
      apiWithoutConnections: [...internal].sort(),
      workflowWorker: [...internal, ...external].sort(),
      mailboxSync: [...internal, ...external].sort(),
      supplierFollowUp: [...internal, ...external].sort(),
      returnFollowUp: [...internal, ...external].sort(),
    });
  });

  it('needs the reply sender as well as mailbox reads to resolve replies', () => {
    const messaging = { ...runtimes.workflowWorker.messaging! };
    delete messaging.sender;

    expect(
      resolvableEffects({ ...runtimes.workflowWorker, messaging }).has('reply'),
    ).toBe(false);
  });

  it('resolves the same dispatch identity, mechanism and executor in every runtime', async () => {
    const api = await adapters(runtimes.api);

    expect(api.every((adapter) => adapter.dispatchIdentity)).toBe(true);
    for (const options of [
      runtimes.workflowWorker,
      runtimes.mailboxSync,
      runtimes.supplierFollowUp,
      runtimes.returnFollowUp,
    ])
      expect(await adapters(options)).toEqual(api);
  });
});
