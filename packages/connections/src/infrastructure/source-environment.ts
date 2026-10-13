import { IdentityError } from '@luma/identity';
import type { TenantDatabase } from '@luma/platform';

import type { SourceEnvironmentRepository } from '../application/source-environment.js';
import type { InstalledConnection } from '../domain/installation.js';
import type {
  SourceEnvironmentDeclaration,
  SourceEnvironmentReview,
} from '../domain/source-environment.js';

/** Immutable reviews and command receipts are retained under the connection owner's restricted role. */
export function createSourceEnvironmentRepository(
  db: TenantDatabase,
): SourceEnvironmentRepository {
  return {
    declaration: (tenantId, id) =>
      db.transaction(
        tenantId,
        async (tx) =>
          (
            await tx.query<{ document: SourceEnvironmentDeclaration }>(
              'SELECT document FROM connector_source_environments WHERE tenant_id=$1 AND connection_id=$2',
              [tenantId, id],
            )
          ).rows[0]?.document ?? null,
      ),
    review: (tenantId, id) =>
      db.transaction(
        tenantId,
        async (tx) =>
          (
            await tx.query<{ document: SourceEnvironmentReview }>(
              'SELECT document FROM connector_source_reviews WHERE tenant_id=$1 AND id=$2',
              [tenantId, id],
            )
          ).rows[0]?.document ?? null,
      ),
    retain: (tenantId, review) =>
      db.transaction(tenantId, async (tx) => {
        await tx.query(
          'INSERT INTO connector_source_reviews(tenant_id,id,connection_id,document) VALUES($1,$2,$3,$4)',
          [tenantId, review.id, review.connectionId, review],
        );
      }),
    change: (context, id, command, fingerprint, apply) =>
      db.transaction(context.tenantId, async (tx) => {
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
          `source-environment:${context.tenantId}`,
        ]);
        const receipt = (
          await tx.query<{
            fingerprint: string;
            document: SourceEnvironmentDeclaration;
          }>(
            'SELECT fingerprint,document FROM connector_source_commands WHERE tenant_id=$1 AND id=$2',
            [context.tenantId, command.commandId],
          )
        ).rows[0];
        if (receipt) {
          if (receipt.fingerprint !== fingerprint)
            throw new IdentityError(409, 'CONFLICT', 'Command ID already used');

          return receipt.document;
        }
        const c = (
          await tx.query<{ document: InstalledConnection }>(
            'SELECT document FROM connector_installations WHERE tenant_id=$1 AND id=$2 FOR SHARE',
            [context.tenantId, id],
          )
        ).rows[0]?.document;
        if (!c)
          throw new IdentityError(404, 'NOT_FOUND', 'Connection not found');
        const previous =
          (
            await tx.query<{ document: SourceEnvironmentDeclaration }>(
              'SELECT document FROM connector_source_environments WHERE tenant_id=$1 AND connection_id=$2',
              [context.tenantId, id],
            )
          ).rows[0]?.document ?? null;
        if ((previous?.revision ?? 0) !== command.expectedRevision)
          throw new IdentityError(
            409,
            'CONFLICT',
            'Declaration changed; refresh it',
          );
        const declaration = await apply(previous, c);
        await tx.query(
          'INSERT INTO connector_source_environments(tenant_id,connection_id,revision,document) VALUES($1,$2,$3,$4) ON CONFLICT(tenant_id,connection_id) DO UPDATE SET revision=EXCLUDED.revision,document=EXCLUDED.document',
          [context.tenantId, id, declaration.revision, declaration],
        );
        await tx.query(
          'INSERT INTO connector_source_commands(tenant_id,id,connection_id,revision,fingerprint,document) VALUES($1,$2,$3,$4,$5,$6)',
          [
            context.tenantId,
            command.commandId,
            id,
            declaration.revision,
            fingerprint,
            declaration,
          ],
        );

        return declaration;
      }),
  };
}
