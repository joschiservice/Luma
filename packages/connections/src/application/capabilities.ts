import { withDispatchGuard } from '@luma/connector-core/dispatch';
import type { TenantContext } from '@luma/identity';
import { requireTenant } from '@luma/identity';

import type {
  Capability,
  CapabilityInput,
  CapabilityOutput,
  CapabilityResult,
  ConnectorFailure,
  ReadCapability,
  WriteCapability,
} from '../domain/capabilities.js';
import { ConnectorError } from '../domain/capabilities.js';
import { equalJson } from '../domain/equal-json.js';
import type {
  EffectAdapter,
  EffectIntent,
  EffectRegistry,
  VerificationResult,
} from './effects.js';

export interface CapabilityDescriptor {
  version: '0';
  minimumRisk: EffectAdapter['minimumRisk'];
  idempotency: 'provider_key' | 'conditional_write' | 'none';
  /** Retry advice never authorizes replay of an uncertain write. */
  retry: { maxAttempts: number; initialDelayMs: number };
  /**
   * Optional read filters the handler honors; absent means none. `order` is a point read of
   * one record by source ID.
   */
  filters?: (
    | 'updatedSince'
    | 'createdSince'
    | 'historyImport'
    | 'confirmMissing'
    | 'order'
  )[];
  /**
   * App permission needed to propose, approve and run this write capability, as
   * `<appId>:<name>`. Without it, proposing needs actions.propose and running needs
   * actions.execute.
   */
  permission?: string;
}

export interface InvocationContext {
  tenant: TenantContext;
  connectionId: string;
  provider: string;
  /** Present for writes; adapters namespace the key by tenant and connection. */
  idempotencyKey?: string;
  /** Internal scheduling intent supplied by a service, outside capability input. */
  readPurpose?: 'foreground' | 'incremental' | 'history';
}

export interface CapabilityHandler<K extends Capability> {
  descriptor: CapabilityDescriptor;
  /** Validate inputs and normalized outputs at the I/O boundary. Throw on invalid data. */
  parseInput(input: unknown): CapabilityInput<K>;
  parseOutput(output: unknown): CapabilityOutput<K>;
  run(
    context: InvocationContext,
    input: CapabilityInput<K>,
  ): Promise<CapabilityOutput<K>>;
}

export interface ConnectorConnection {
  tenantId: string;
  id: string;
  provider: string;
  status: 'active' | 'degraded' | 'revoked' | 'disconnected' | 'pending';
  adapterVersion: string;
  mechanism: EffectAdapter['mechanism'];
  executor: EffectAdapter['executor'];
  capabilities: { [K in Capability]?: CapabilityHandler<K> };
}

export interface CapabilityEvent {
  tenantId: string;
  connectionId: string;
  correlationId: string;
  provider: string;
  adapterVersion: string;
  mechanism: EffectAdapter['mechanism'];
  executor: EffectAdapter['executor'];
  capability: Capability;
  version: '0';
  phase: 'started' | 'succeeded' | 'failed';
  error?: ConnectorFailure;
}

export interface CapabilityDependencies {
  /** Resolve current connection state with tenant scope; do not return credentials. */
  resolve(
    context: TenantContext,
    connectionId: string,
  ): Promise<ConnectorConnection | null>;
  /** Awaited evidence hook. No input, output, provider payload or exception text is included. */
  record(event: CapabilityEvent): Promise<void>;
}

export interface CapabilityRequest<K extends Capability> {
  connectionId: string;
  capability: K;
  version: '0';
  input: CapabilityInput<K>;
  /** Trusted scheduling metadata, never accepted from a capability's public input schema. */
  readPurpose?: 'foreground' | 'incremental' | 'history';
}

export type WriteRequest<K extends WriteCapability> = CapabilityRequest<K> & {
  idempotencyKey: string;
};

function failure(code: ConnectorFailure['code']): ConnectorFailure {
  return { code, effect: 'none', retry: 'never' };
}

function dispatchIdentity(
  connection: ConnectorConnection,
  capability: Capability,
): string {
  return JSON.stringify([
    connection.provider,
    connection.adapterVersion,
    connection.mechanism,
    connection.executor,
    connection.capabilities[capability]?.descriptor,
  ]);
}

/** Inject writes only into execution adapters; application callers receive the read port. */
export function createCapabilityRuntime(deps: CapabilityDependencies) {
  async function resolve(context: TenantContext, connectionId: string) {
    requireTenant(context, context.tenantId);
    const connection = await deps.resolve(context, connectionId);
    if (
      !connection ||
      connection.id !== connectionId ||
      connection.tenantId !== context.tenantId ||
      connection.status !== 'active'
    )
      return null;

    return connection;
  }

  async function invoke<K extends Capability>(
    context: TenantContext,
    request: CapabilityRequest<K>,
    write: boolean,
    idempotencyKey?: string,
    expectedDispatchIdentity?: string,
    beforeDispatch?: (firstDispatch?: boolean) => Promise<void>,
  ): Promise<CapabilityResult<K>> {
    const connection = await resolve(context, request.connectionId);
    if (!connection) return { ok: false, error: failure('unavailable') };
    if (
      expectedDispatchIdentity !== undefined &&
      dispatchIdentity(connection, request.capability) !==
        expectedDispatchIdentity
    )
      return { ok: false, error: failure('conflict') };
    const handler = connection.capabilities[request.capability] as
      CapabilityHandler<K> | undefined;
    if (!handler)
      return { ok: false, error: failure('unsupported_capability') };
    if (handler.descriptor.version !== request.version)
      return { ok: false, error: failure('unsupported_version') };
    if (
      write !== !request.capability.endsWith('.read') ||
      (write && !idempotencyKey?.trim())
    )
      return { ok: false, error: failure('invalid_input') };
    let input: CapabilityInput<K>;
    try {
      input = handler.parseInput(request.input);
    } catch {
      return { ok: false, error: failure('invalid_input') };
    }
    const event: Omit<CapabilityEvent, 'phase'> = {
      tenantId: context.tenantId,
      connectionId: connection.id,
      correlationId: context.requestId,
      provider: connection.provider,
      adapterVersion: connection.adapterVersion,
      mechanism: connection.mechanism,
      executor: connection.executor,
      capability: request.capability,
      version: request.version,
    };
    // Failed pre-dispatch evidence must prevent the call. Post-dispatch failure propagates to execution.
    await deps.record({ ...event, phase: 'started' });
    let result: CapabilityResult<K>;
    try {
      const output = await withDispatchGuard(beforeDispatch, () =>
        handler.run(
          {
            tenant: context,
            connectionId: connection.id,
            provider: connection.provider,
            ...(request.readPurpose
              ? { readPurpose: request.readPurpose }
              : {}),
            ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
          },
          input,
        ),
      );
      try {
        const value = handler.parseOutput(output);
        // Attachment reads return content, not observations, so only pages carry provenance.
        if (!write && typeof value === 'object' && 'items' in value) {
          const page = value as Extract<
            CapabilityOutput<ReadCapability>,
            { items: unknown }
          >;
          if (
            page.items.some(
              ({ source, adapterVersion, schemaVersion }) =>
                source.tenantId !== context.tenantId ||
                source.connectionId !== connection.id ||
                source.provider !== connection.provider ||
                adapterVersion !== connection.adapterVersion ||
                schemaVersion !== 1,
            )
          )
            throw new Error('Observation provenance mismatch');
        }
        result = { ok: true, value };
      } catch {
        result = {
          ok: false,
          error: {
            code: 'invalid_response',
            effect: write ? 'unknown' : 'none',
            retry: write ? 'reconcile' : 'never',
          },
        };
      }
    } catch (error) {
      const normalized =
        error instanceof ConnectorError
          ? error.failure
          : {
              code: 'internal' as const,
              effect: write ? ('unknown' as const) : ('none' as const),
              retry: write ? ('reconcile' as const) : ('never' as const),
            };
      result = {
        ok: false,
        error:
          normalized.effect === 'unknown'
            ? { ...normalized, retry: 'reconcile' }
            : normalized,
      };
    }
    await deps.record({
      ...event,
      phase: result.ok ? 'succeeded' : 'failed',
      ...(result.ok ? {} : { error: result.error }),
    });

    return result;
  }

  return {
    async discover(context: TenantContext, connectionId: string) {
      const connection = await resolve(context, connectionId);
      if (!connection) return [];

      return Object.entries(connection.capabilities).map(
        ([capability, handler]) => ({
          capability: capability as Capability,
          ...structuredClone(handler.descriptor),
        }),
      );
    },
    read<K extends ReadCapability>(
      context: TenantContext,
      request: CapabilityRequest<K>,
    ) {
      return invoke(context, request, false);
    },
    write<K extends WriteCapability>(
      context: TenantContext,
      request: WriteRequest<K>,
    ) {
      return invoke(context, request, true, request.idempotencyKey);
    },
    /** Bind canonical intent mapping and authoritative verification to the existing safety service. */
    effects<K extends WriteCapability>(binding: {
      capability: K;
      /** Validate parameters and target/evidence ownership, and map canonical IDs to external IDs. */
      map(
        context: TenantContext,
        intent: EffectIntent,
      ): Promise<CapabilityInput<K> | null>;
      checkPreconditions(
        context: TenantContext,
        intent: EffectIntent,
      ): Promise<boolean>;
      verify(
        context: TenantContext,
        intent: EffectIntent,
      ): Promise<VerificationResult>;
    }): EffectRegistry {
      return {
        async resolve(context, intent) {
          requireTenant(context, intent.tenantId);
          if (
            intent.capability !== binding.capability ||
            intent.capabilityVersion !== '0'
          )
            return null;
          const connection = await resolve(context, intent.connectionId);
          const handler = connection?.capabilities[binding.capability];
          if (!connection || !handler || handler.descriptor.version !== '0')
            return null;
          const input = await binding.map(context, intent);
          if (!input) return null;
          try {
            handler.parseInput(input);
          } catch {
            return null;
          }
          const expectedIdentity = dispatchIdentity(
            connection,
            binding.capability,
          );
          const boundIntent = structuredClone(intent);
          const boundInput = structuredClone(input);

          return {
            dispatchIdentity: expectedIdentity,
            capability: binding.capability,
            version: '0',
            minimumRisk: handler.descriptor.minimumRisk,
            ...(handler.descriptor.permission
              ? { permission: handler.descriptor.permission }
              : {}),
            mechanism: connection.mechanism,
            executor: connection.executor,
            checkPreconditions: (action) =>
              binding.checkPreconditions(context, action),
            async execute(action, idempotencyKey, beforeDispatch) {
              if (!equalJson(action, boundIntent))
                throw new ConnectorError(failure('conflict'));
              const result = await invoke(
                context,
                {
                  connectionId: action.connectionId,
                  capability: binding.capability,
                  version: '0',
                  input: boundInput,
                },
                true,
                idempotencyKey,
                expectedIdentity,
                beforeDispatch,
              );
              if (!result.ok) throw new ConnectorError(result.error);

              return {
                evidenceRefs: result.value.evidenceRefs,
                providerRequestId: result.value.providerRequestId,
              };
            },
            verify: (action) => binding.verify(context, action),
          };
        },
      };
    },
  };
}

export type CapabilityRuntime = ReturnType<typeof createCapabilityRuntime>;

export type CapabilityReader = Pick<CapabilityRuntime, 'discover' | 'read'>;
