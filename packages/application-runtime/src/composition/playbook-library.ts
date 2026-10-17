import { createPlaybookGrantReader } from '@luma/connections/composition';
import { createAdmissionStore } from '@luma/execution/composition';
import type { IdentityService } from '@luma/identity';
import { requireTenant } from '@luma/identity';
import type { TenantDatabase } from '@luma/platform';
import type { PolicyService } from '@luma/policies';
import type { PlaybookLibrary } from '@luma/workflows';
import {
  activationRequestSchema,
  createPlaybookActivations,
  createPlaybookLibrary,
  createPlaybookLibraryStore,
  createPlaybookStore,
  lockPlaybookManagement,
} from '@luma/workflows/composition';

/** Composes atomic reviewed activations with the existing admission artifact store. */
export function createPersistentPlaybookLibrary(
  db: TenantDatabase,
  identity: Pick<IdentityService, 'refreshContext'>,
  approvalPolicy: Pick<PolicyService, 'approvalRequirement'>,
): PlaybookLibrary {
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
    approvalPolicy,
    transaction: (context, operation) =>
      db.transaction(context.tenantId, async (tx) => {
        await lockPlaybookManagement(tx, context.tenantId);
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
