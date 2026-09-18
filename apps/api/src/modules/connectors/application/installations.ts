import {
  IdentityError,
  requireRole,
  requireTenant,
} from '../../identity/index.js';
import type { TenantContext } from '../../identity/index.js';
import { ConnectorError } from '../domain/capabilities.js';
import type { InstallationCapability } from '../domain/installation.js';
import type {
  InstallationInput,
  InstalledConnection,
  InstallationCredentials,
} from '../domain/installation.js';

export interface StoredInstallation {
  connection: InstalledConnection;
  secret: string | null;
}
export interface InstallationRepository {
  list(tenantId: string): Promise<InstalledConnection[]>;
  get(tenantId: string, id: string): Promise<StoredInstallation | null>;
  save(
    record: StoredInstallation,
    expectedVersion: number | null,
    actorId: string,
    event: string,
  ): Promise<boolean>;
}
export interface SecretCipher {
  seal(value: InstallationCredentials, binding: string): string;
  open(value: string, binding: string): InstallationCredentials;
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
  /** Verify account identity and provider grants. Must enforce approved JTL network destinations before connecting. */
  verify(
    connection: InstalledConnection,
    credentials: InstallationCredentials,
  ): Promise<InstallationCapability[]>;
  id(): string;
  now(): Date;
}
export const secretBinding = (c: InstalledConnection) =>
  JSON.stringify([
    c.tenantId,
    c.id,
    Object.entries(c.target).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    c.credentialVersion,
  ]);
const unavailable = () =>
  new IdentityError(404, 'NOT_FOUND', 'Connection not found');
const conflict = () =>
  new IdentityError(409, 'CONFLICT', 'Connection changed; reload and retry');

export function createInstallationService(deps: InstallationDependencies) {
  async function authorize(context: TenantContext, admin = false) {
    requireTenant(context, context.tenantId);
    const fresh = await deps.refreshContext(context);
    requireTenant(fresh, context.tenantId);
    if (admin) requireRole(fresh, ['owner', 'admin']);
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
    return record;
  }
  async function save(
    record: StoredInstallation,
    version: number | null,
    actor: string,
    event: string,
  ) {
    if (!(await deps.repository.save(record, version, actor, event)))
      throw conflict();
    return record.connection;
  }
  return {
    async list(context: TenantContext) {
      const fresh = await authorize(context);
      return deps.repository.list(fresh.tenantId);
    },
    async install(context: TenantContext, input: unknown) {
      const fresh = await authorize(context, true);
      let parsed: InstallationInput;
      try {
        parsed = deps.boundary.input(input);
      } catch {
        throw new IdentityError(422, 'CONFLICT', 'Invalid connection settings');
      }
      const { credentials, ...settings } = parsed;
      const timestamp = deps.now().toISOString();
      const connection: InstalledConnection = {
        ...settings,
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
      if (
        record.connection.version !== version ||
        ['revoked', 'disconnected'].includes(record.connection.status)
      )
        throw conflict();
      let credentials: InstallationCredentials;
      try {
        credentials = deps.boundary.credentials(input);
        if (
          record.connection.target.kind === 'jtl-onprem' &&
          !credentials.challengeCode
        )
          throw new Error();
      } catch {
        throw new IdentityError(422, 'CONFLICT', 'Invalid credentials');
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
        throw conflict();
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
        throw conflict();
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
      if (
        !record.connection.permissions.includes(capability) ||
        !record.connection.granted.includes(capability)
      )
        throw new ConnectorError({
          code: 'permission_denied',
          effect: 'none',
          retry: 'never',
        });
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
export type InstallationService = ReturnType<typeof createInstallationService>;
