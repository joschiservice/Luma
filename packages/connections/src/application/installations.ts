import type { TenantContext } from '@luma/identity';
import {
  isOwner,
  requireChangesAllowed,
  requirePermission,
  requireTenant,
} from '@luma/identity';
import { conflict, forbidden, notFound, ServiceError } from '@luma/platform';

import { ConnectorError } from '../domain/capabilities.js';
import type {
  InstallationCapability,
  InstallationCredentials,
  InstallationInput,
  InstalledConnection,
} from '../domain/installation.js';

export interface StoredInstallation {
  connection: InstalledConnection;
  secret: string | null;
}

export interface InstallationRepository {
  /** Lists public connection state without decrypted credentials. */
  list(tenantId: string): Promise<InstalledConnection[]>;
  /** Returns the stored encrypted credentials, or null when this tenant has no matching connection. */
  get(tenantId: string, id: string): Promise<StoredInstallation | null>;
  /** Saves and records a lifecycle event if the version matches; null expects a new installation. */
  save(
    record: StoredInstallation,
    expectedVersion: number | null,
    actorId: string,
    event: string,
  ): Promise<boolean>;
}

export interface SecretCipher {
  /** Encrypts credentials and binds them to the supplied connection identity. */
  seal(value: InstallationCredentials, binding: string): string;
  /** Decrypts credentials; rejects tampered ciphertext, unavailable keys, or a mismatched binding. */
  open(value: string, binding: string): InstallationCredentials;
}

/** Tenant-scoped connection commands. Mutations require current `connections.manage` permission. */
export interface ConnectionManagement {
  /** Owners may impose observe-only or restore workspace inheritance, using the reviewed version. */
  updateWriteMode(
    context: TenantContext,
    id: string,
    version: number,
    writeMode: 'observe_only' | null,
  ): Promise<InstalledConnection>;
  /** Lists connections visible to the current tenant without credentials. */
  list(context: TenantContext): Promise<InstalledConnection[]>;
  /** Validates settings and stores encrypted credentials in a pending connection. */
  install(context: TenantContext, input: unknown): Promise<InstalledConnection>;
  /**
   * Replaces credentials and clears grants, which reconnects a connection the provider revoked
   * under the same ID. Rejects stale versions and disconnected connections.
   */
  rotate(
    context: TenantContext,
    id: string,
    version: number,
    input: unknown,
  ): Promise<InstalledConnection>;
  /** Refreshes provider grants and health; rejects stale versions or unavailable credentials. */
  check(
    context: TenantContext,
    id: string,
    version: number,
  ): Promise<InstalledConnection>;
  /** Removes credentials and grants; rejects stale versions. Defaults to disconnected. */
  disconnect(
    context: TenantContext,
    id: string,
    version: number,
    status?: 'disconnected' | 'revoked',
  ): Promise<InstalledConnection>;
}

/** Adds trusted adapter operations to the public connection management contract. */
export interface InstallationService extends ConnectionManagement {
  /** Records provider access failures only when the active credential version still matches. */
  recordFailure(
    context: TenantContext,
    id: string,
    credentialVersion: number,
    code: 'authentication' | 'permission_denied',
  ): Promise<void>;
  /** Returns credentials for an active, permitted capability. Keep this port out of HTTP and workflow interfaces. */
  credential(
    context: TenantContext,
    id: string,
    capability: InstallationCapability,
  ): Promise<{
    connection: InstalledConnection;
    credentials: InstallationCredentials;
  }>;
}

export interface InstallationDependencies {
  boundary: {
    input(value: unknown): InstallationInput;
    credentials(value: unknown): InstallationCredentials;
    permissions(value: unknown): InstallationCapability[];
  };
  repository: InstallationRepository;
  cipher: SecretCipher;
  refreshContext(context: TenantContext): Promise<TenantContext>;
  /** Verify account identity and provider grants. Must enforce deployment network policy before connecting. */
  verify(
    connection: InstalledConnection,
    credentials: InstallationCredentials,
  ): Promise<InstallationCapability[]>;
  refreshCredential?(
    context: TenantContext,
    id: string,
    target: InstalledConnection['target'],
  ): Promise<InstallationCredentials | void>;
  /** Checks app availability and validates app-owned settings before use. */
  provider?(
    context: TenantContext,
    target: InstalledConnection['target'],
  ): Promise<{
    appId: string;
    provider: string;
    appInstallationVersion: number;
    management?: ('check' | 'rotate')[];
  }>;
  /** Rejects manual health checks when an app requires its own authorization flow. */
  beforeCheck?(target: InstalledConnection['target']): void;
  validate?(input: InstallationInput): InstallationInput;
  validateCredentials?(
    target: InstalledConnection['target'],
    value: unknown,
  ): InstallationCredentials;
  id(): string;
  now(): Date;
}

/**
 * Identifies the tenant, connection, and credential version that encrypted credentials
 * belong to.
 */
export const secretBinding = (c: InstalledConnection) =>
  JSON.stringify([
    c.tenantId,
    c.id,
    Object.entries(c.target).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    c.credentialVersion,
  ]);

function requireCapability(
  connection: InstalledConnection,
  capability: InstallationCapability,
): void {
  if (
    !connection.permissions.includes(capability) ||
    !connection.granted.includes(capability)
  )
    throw new ConnectorError({
      code: 'permission_denied',
      effect: 'none',
      retry: 'never',
    });
}

const unavailable = () => notFound('Connection not found');

const changed = () => conflict('Connection changed; reload and retry');

/**
 * Creates connection lifecycle commands that refresh authorization, validate input, and
 * encrypt stored credentials.
 */
export function createInstallationService(
  deps: InstallationDependencies,
): InstallationService {
  async function authorize(context: TenantContext, manage = false) {
    requireTenant(context, context.tenantId);
    const fresh = await deps.refreshContext(context);
    requireTenant(fresh, context.tenantId);
    if (manage) requirePermission(fresh, 'connections.manage');

    return fresh;
  }

  async function get(context: TenantContext, id: string) {
    const record = await deps.repository.get(context.tenantId, id);
    if (
      !record ||
      record.connection.tenantId !== context.tenantId ||
      record.connection.id !== id
    )
      throw unavailable();

    if (record.connection.provider === 'luma-erp')
      throw conflict('Built-in sources are managed by Luma');

    return record;
  }

  async function save(
    record: StoredInstallation,
    version: number | null,
    actor: string,
    event: string,
  ) {
    if (!(await deps.repository.save(record, version, actor, event)))
      throw changed();

    return record.connection;
  }

  return {
    async updateWriteMode(context, id, version, writeMode) {
      requireChangesAllowed(context);
      const fresh = await authorize(context);
      if (!isOwner(fresh))
        throw forbidden('Only workspace owners can change write mode.');
      if (writeMode !== null && writeMode !== 'observe_only')
        throw new ServiceError(
          422,
          'CONFLICT',
          'Invalid connection write mode',
        );
      const record = await get(fresh, id);
      if (record.connection.version !== version) throw changed();
      if ((record.connection.writeMode ?? null) === writeMode)
        return record.connection;

      return save(
        {
          ...record,
          connection: {
            ...record.connection,
            writeMode,
            version: version + 1,
            updatedAt: deps.now().toISOString(),
          },
        },
        version,
        fresh.actor.id,
        'write_mode_changed',
      );
    },
    async list(context: TenantContext) {
      const fresh = await authorize(context);

      return deps.repository.list(fresh.tenantId);
    },
    async install(context: TenantContext, input: unknown) {
      const fresh = await authorize(context, true);
      let parsed: InstallationInput;
      try {
        parsed = deps.boundary.input(input);
        if (deps.validate) parsed = deps.validate(parsed);
      } catch {
        throw new ServiceError(422, 'CONFLICT', 'Invalid connection settings');
      }
      const ownership = await deps.provider?.(fresh, parsed.target);
      const { credentials, ...settings } = parsed;
      const timestamp = deps.now().toISOString();
      const connection: InstalledConnection = {
        ...settings,
        ...ownership,
        id: deps.id(),
        tenantId: fresh.tenantId,
        granted: [],
        status: 'pending',
        version: 1,
        credentialVersion: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
      };

      return save(
        {
          connection,
          secret: deps.cipher.seal(credentials, secretBinding(connection)),
        },
        null,
        fresh.actor.id,
        'installed',
      );
    },
    async rotate(
      context: TenantContext,
      id: string,
      version: number,
      input: unknown,
    ) {
      const fresh = await authorize(context, true);
      const record = await get(fresh, id);
      // Only providers revoke; people disconnect. A revoked connection keeps its mappings and
      // history when someone reconnects it.
      if (
        record.connection.version !== version ||
        record.connection.status === 'disconnected'
      )
        throw changed();
      await deps.provider?.(fresh, record.connection.target);
      let credentials: InstallationCredentials;
      try {
        credentials = deps.boundary.credentials(input);
        if (deps.validateCredentials)
          credentials = deps.validateCredentials(
            record.connection.target,
            input,
          );
      } catch {
        throw new ServiceError(422, 'CONFLICT', 'Invalid credentials');
      }
      const connection: InstalledConnection = {
        ...record.connection,
        version: version + 1,
        credentialVersion: record.connection.credentialVersion + 1,
        status: 'pending',
        granted: [],
        updatedAt: deps.now().toISOString(),
      };

      return save(
        {
          connection,
          secret: deps.cipher.seal(credentials, secretBinding(connection)),
        },
        version,
        fresh.actor.id,
        'credentials_rotated',
      );
    },
    async check(context: TenantContext, id: string, version: number) {
      const fresh = await authorize(context, true);
      const record = await get(fresh, id);
      if (
        record.connection.version !== version ||
        !record.secret ||
        ['revoked', 'disconnected'].includes(record.connection.status)
      )
        throw changed();
      await deps.provider?.(fresh, record.connection.target);
      deps.beforeCheck?.(record.connection.target);
      let granted: InstallationCapability[] = [];
      let status: InstalledConnection['status'] = 'degraded';
      try {
        granted = deps.boundary.permissions(
          await deps.verify(
            record.connection,
            deps.cipher.open(record.secret, secretBinding(record.connection)),
          ),
        );
        if (
          record.connection.permissions.every((capability) =>
            granted.includes(capability),
          )
        )
          status = 'active';
      } catch {
        // Provider errors can contain credentials; retain only a controlled health state.
      }
      const current = await authorize(context, true);

      return save(
        {
          secret: record.secret,
          connection: {
            ...record.connection,
            granted: [...new Set(granted)],
            status,
            version: version + 1,
            updatedAt: deps.now().toISOString(),
          },
        },
        version,
        current.actor.id,
        'health_checked',
      );
    },
    async disconnect(
      context: TenantContext,
      id: string,
      version: number,
      status: 'disconnected' | 'revoked' = 'disconnected',
    ) {
      const fresh = await authorize(context, true);
      const record = await get(fresh, id);
      if (
        record.connection.version !== version ||
        !['disconnected', 'revoked'].includes(status)
      )
        throw changed();

      return save(
        {
          secret: null,
          connection: {
            ...record.connection,
            status,
            granted: [],
            version: version + 1,
            updatedAt: deps.now().toISOString(),
          },
        },
        version,
        fresh.actor.id,
        status,
      );
    },
    /** Record provider authorization failures only for the credentials that failed. */
    async recordFailure(
      context: TenantContext,
      id: string,
      credentialVersion: number,
      code: 'authentication' | 'permission_denied',
    ) {
      const fresh = await authorize(context);
      const record = await get(fresh, id);
      if (
        record.connection.status !== 'active' ||
        record.connection.credentialVersion !== credentialVersion
      )
        return;
      await deps.repository.save(
        {
          connection: {
            ...record.connection,
            status: code === 'authentication' ? 'revoked' : 'degraded',
            granted: [],
            version: record.connection.version + 1,
            updatedAt: deps.now().toISOString(),
          },
          secret: code === 'authentication' ? null : record.secret,
        },
        record.connection.version,
        fresh.actor.id,
        'provider_access_failed',
      );
    },
    /** Trusted adapter port. Never expose credentials through HTTP or workflow interfaces. */
    async credential(
      context: TenantContext,
      id: string,
      capability: InstallationCapability,
    ) {
      const fresh = await authorize(context);
      const record = await get(fresh, id);
      if (record.connection.status !== 'active' || !record.secret)
        throw new ConnectorError({
          code: 'unavailable',
          effect: 'none',
          retry: 'never',
        });
      await deps.provider?.(fresh, record.connection.target);
      requireCapability(record.connection, capability);
      if (deps.refreshCredential) {
        await deps.refreshCredential(fresh, id, record.connection.target);
        const latest = await get(fresh, id);
        if (latest.connection.status !== 'active' || !latest.secret)
          throw unavailable();
        requireCapability(latest.connection, capability);

        return {
          connection: latest.connection,
          credentials: deps.cipher.open(
            latest.secret,
            secretBinding(latest.connection),
          ),
        };
      }

      return {
        connection: record.connection,
        credentials: deps.cipher.open(
          record.secret,
          secretBinding(record.connection),
        ),
      };
    },
  };
}
