import type { SqlTransaction, TenantDatabase } from '@luma/platform';
import { conflict, notFound } from '@luma/platform';
import { z } from 'zod';

import type {
  AuthorityEvent,
  AuthorityRepository,
  AuthorityState,
} from '../application/authority.js';
import type { AuthorityConnection } from '../domain/authority.js';
import { authorityGroups, eligibleAuthority } from '../domain/authority.js';
import type { InstalledConnection } from '../domain/installation.js';

const authorityChangeSchema = z
  .object({
    commandId: z.string().uuid(),
    revision: z.number().int().nonnegative(),
    group: z.enum(authorityGroups),
    connectionId: z.string().uuid().nullable(),
  })
  .strict();

const settingsSchema = z.object({
  revision: z.number().int().nonnegative(),
  overrides: z.partialRecord(z.enum(authorityGroups), z.string().uuid()),
});

/** Creates authority storage. Category lookup belongs to the installed provider catalog. */
export function createAuthorityRepository(
  db: TenantDatabase,
  category: (provider: string) => AuthorityConnection['category'],
  internalOrdersEnabled: (tenantId: string) => Promise<boolean> = async () =>
    false,
): AuthorityRepository {
  async function read(
    tx: SqlTransaction,
    tenantId: string,
  ): Promise<AuthorityState> {
    const settings = await tx.query(
      'SELECT revision,overrides FROM connector_authority_settings WHERE tenant_id=$1',
      [tenantId],
    );
    const connections = await tx.query<{
      document: InstalledConnection;
      installed: boolean;
    }>(
      `SELECT c.document, (c.document->>'appId' IS NULL OR EXISTS(SELECT 1 FROM workspace_apps a
        WHERE a.tenant_id=c.tenant_id AND a.app_id=c.document->>'appId' AND a.status='installed'
        AND a.version=(c.document->>'appInstallationVersion')::int)) AS installed
       FROM connector_installations c WHERE c.tenant_id=$1 ORDER BY c.id`,
      [tenantId],
    );

    const internalVisible = await internalOrdersEnabled(tenantId);

    return {
      ...settingsSchema.parse(
        settings.rows[0] ?? { revision: 0, overrides: {} },
      ),
      connections: connections.rows
        .filter(
          ({ document: c }) => c.provider !== 'luma-erp' || internalVisible,
        )
        .map(({ document: c, installed }) => ({
          id: c.id,
          label: c.label,
          category: category(c.provider ?? c.target.kind),
          ...(c.provider === 'luma-erp' ? { explicitSelection: true } : {}),
          available: installed && ['active', 'degraded'].includes(c.status),
          capabilities: c.permissions.filter((capability) =>
            c.granted.includes(capability),
          ),
        })),
    };
  }

  return {
    read: (tenantId) =>
      db.transaction(tenantId, (tx) => read(tx, tenantId), {
        readOnlySnapshot: true,
      }),
    change: (tenantId, actorId, input) =>
      db.transaction(tenantId, async (tx) => {
        input = authorityChangeSchema.parse(input);
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
          `source-authority:${tenantId}`,
        ]);
        const receipt = await tx.query<{ document: AuthorityEvent }>(
          'SELECT document FROM connector_authority_events WHERE tenant_id=$1 AND command_id=$2',
          [tenantId, input.commandId],
        );
        const previous = receipt.rows[0]?.document;
        if (previous) {
          if (
            previous.actorId !== actorId ||
            previous.revision !== input.revision + 1 ||
            previous.group !== input.group ||
            previous.connectionId !== input.connectionId
          )
            throw conflict('Authority command ID already used');

          return previous;
        }
        // Lock the reviewed connection before checking its current grants and app state.
        if (input.connectionId)
          await tx.query(
            'SELECT id FROM connector_installations WHERE tenant_id=$1 AND id=$2 FOR SHARE',
            [tenantId, input.connectionId],
          );
        const state = await read(tx, tenantId);
        if (state.revision !== input.revision)
          throw conflict('Source authority changed; reload and retry');
        if (input.connectionId) {
          const connection = state.connections.find(
            (c) => c.id === input.connectionId,
          );
          if (!connection) throw notFound('Connection not found');
          if (!eligibleAuthority(input.group, connection))
            throw conflict('Connection cannot supply this fact group');
        }
        const overrides = { ...state.overrides };
        if (input.connectionId) overrides[input.group] = input.connectionId;
        else delete overrides[input.group];
        const event: AuthorityEvent = {
          ...input,
          revision: state.revision + 1,
          actorId,
          previousConnectionId: state.overrides[input.group] ?? null,
          occurredAt: new Date().toISOString(),
        };
        await tx.query(
          `INSERT INTO connector_authority_settings(tenant_id,revision,overrides) VALUES($1,$2,$3)
        ON CONFLICT(tenant_id) DO UPDATE SET revision=EXCLUDED.revision,overrides=EXCLUDED.overrides`,
          [tenantId, event.revision, overrides],
        );
        await tx.query(
          'INSERT INTO connector_authority_events(tenant_id,command_id,revision,document) VALUES($1,$2,$3,$4)',
          [tenantId, input.commandId, event.revision, event],
        );

        return event;
      }),
    history: (tenantId) =>
      db.transaction(tenantId, async (tx) =>
        (
          await tx.query<{ document: AuthorityEvent }>(
            'SELECT document FROM connector_authority_events WHERE tenant_id=$1 ORDER BY revision DESC LIMIT 100',
            [tenantId],
          )
        ).rows.map((row) => row.document),
      ),
  };
}
