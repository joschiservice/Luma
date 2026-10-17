import { createHash, randomUUID } from 'node:crypto';

import { replenishmentRuleSchema } from '@luma/api-contract';
import { createAuditLog } from '@luma/audit/composition';
import type { IdentityService, TenantContext } from '@luma/identity';
import type { TenantDatabase } from '@luma/platform';
import { conflict } from '@luma/platform';
import type { ProcurementService } from '@luma/procurement';
import {
  createReplenishmentService,
  replenishmentSource,
  type ReplenishmentTransport,
} from '@luma/procurement';
import { createReplenishmentStore } from '@luma/procurement/composition';
import {
  compileProcessWorkflow,
  createCodeJournal,
  createProcessStepStore,
  createWasmtimeRunner,
  createWorkflowCatalogStore,
  createWorkflowTriggers,
  createWorkflowTriggerStore,
  parseProcessSnapshot,
  playbookHash,
} from '@luma/workflows/composition';

import { createProcurementEffects } from './procurement-effects.js';
import type { createSafetyServices } from './services.js';

export type { ReplenishmentTransport } from '@luma/procurement';

/** Wires procurement workflow use cases to tenant persistence and shared execution services. */
export function createReplenishmentRuntime(deps: {
  db: TenantDatabase;
  identity: Pick<
    IdentityService,
    'refreshContext' | 'resolveWorkflowContext' | 'suspendedMembers'
  >;
  procurement: ProcurementService;
  safety: ReturnType<typeof createSafetyServices>;
  transport?: ReplenishmentTransport;
  enabled: boolean;
  refreshStock?: (context: TenantContext, positionId: string) => Promise<void>;
  reviewContext?: NonNullable<
    Parameters<typeof createReplenishmentService>[0]['reviewContext']
  >;
}) {
  const version = compileProcessWorkflow(replenishmentSource);
  const store = createReplenishmentStore(deps.db);
  const runs = createWorkflowTriggerStore(deps.db);
  const triggers = createWorkflowTriggers({
    store: {
      ...runs,
      insert: async (context, key, run) => {
        const rule = (await store.list(context)).find(
          (r) => r.id === run.context.inputs.activationId,
        );
        if (!rule?.active || rule.principalId !== context.actor.id)
          throw conflict(
            'The replenishment activation changed. Refresh before starting.',
          );

        return runs.insert(context, key, {
          ...run,
          activationId: rule.id,
          artifactDigest: rule.artifactDigest,
        });
      },
    },
    refreshContext: deps.identity.refreshContext,
    parseSnapshot: (input) => parseProcessSnapshot(input, version),
    hash: playbookHash,
    id: randomUUID,
    now: () => new Date(),
  });

  return createReplenishmentService({
    ...(process.env.LUMA_CODE_RUNTIME_DIR
      ? {
          code: {
            runner: createWasmtimeRunner({
              directory: process.env.LUMA_CODE_RUNTIME_DIR,
            }),
            journal: createCodeJournal(deps.db, (run) =>
              deps.identity.resolveWorkflowContext(
                run.actor.id,
                run.tenantId,
                run.id,
              ),
            ),
          },
        }
      : {}),
    hash: playbookHash,
    id: (value) => {
      const hex = createHash('sha256').update(value).digest('hex');

      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
    },
    ...deps,
    version,
    store,
    runs,
    triggers,
    steps: createProcessStepStore(deps.db),
    catalog: createWorkflowCatalogStore(deps.db),
    effects: createProcurementEffects(deps.procurement),
    audit: createAuditLog(deps.db),
    parseRule: (input) => replenishmentRuleSchema.parse(input),
  });
}
