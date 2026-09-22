import { createPlaybookGrantReader } from '#modules/connectors/composition';
import { createAdmissionStore } from '#modules/execution/composition';
import type { IdentityService } from '#modules/identity/index';
import { requireTenant } from '#modules/identity/index';
import type { TenantDatabase } from '#modules/platform/index';
import {
  activationRequestSchema,
  createPlaybookActivations,
  createPlaybookLibrary,
  createPlaybookLibraryStore,
  createPlaybookStore,
} from '#modules/workflows/composition';

/** Composes atomic reviewed activations with the existing admission artifact store. */
export function createPersistentPlaybookLibrary(
  db: TenantDatabase,
  identity: Pick<IdentityService, 'refreshContext'>,
) {
  const scope = (database: TenantDatabase) => ({
    store: createPlaybookLibraryStore(database),
    grants: createPlaybookGrantReader(database),
    commands: createPlaybookActivations({
      store: createPlaybookStore(database),
      provisioning: createAdmissionStore(database),
      refreshContext: identity.refreshContext,
      parseActivation: (input) => activationRequestSchema.parse(input),
    }),
  });

  return createPlaybookLibrary({
    ...scope(db),
    refreshContext: identity.refreshContext,
    transaction: (context, operation) =>
      db.transaction(context.tenantId, async (tx) => {
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
          `playbook-management:${context.tenantId}`,
        ]);
        const scoped: TenantDatabase = {
          transaction: async (tenantId, work) => {
            requireTenant(context, tenantId);

            return work(tx);
          },
        };

        return operation(scope(scoped));
      }),
  });
}
