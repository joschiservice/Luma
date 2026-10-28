import { createAuditLog } from '@luma/audit/composition';
import type { EffectRegistry } from '@luma/connections';
import { describeActionDiff } from '@luma/connections';
import type { IdentityService } from '@luma/identity';
import {
  createReturnActionService,
  createReturnCaseService,
  createReturnDeadlineService,
  createReturnExchangeService,
  createReturnMoneySource,
  type ReturnActions,
  type ReturnCases,
  type ReturnDeadlines,
  type ReturnExchanges,
} from '@luma/orders/composition';
import type { TenantDatabase } from '@luma/platform';

import type { ApplicationOptions, EffectFamily } from './application.js';
import type { createTenantFeatureRelease } from './feature-release.js';
import {
  createReturnCreationAdmission,
  createReturnSystem,
} from './return-cases.js';
import { createReturnConsistencySystem } from './return-consistency.js';
import { createReturnExchangeAdmission } from './return-exchanges.js';
import {
  createReturnSettlementAdmission,
  createReturnSettlementSystem,
} from './return-settlement.js';
import type { createSafetyServices } from './services.js';

/**
 * Composes return cases, refunds, exchanges and return deadlines. Without installed return
 * connections, cases work locally and sent money cannot be read. Each provider write is admitted
 * through `safety` and `effects` only when its effect family is resolvable; otherwise it has no
 * admission. Action diffs are described only for tenants with the `action-review-diffs` release.
 */
export function createReturnServices(options: {
  database: TenantDatabase;
  identity: Pick<IdentityService, 'refreshContext' | 'resolveWorkflowContext'>;
  returns: ApplicationOptions['returns'];
  resolvable: ReadonlySet<EffectFamily>;
  safety: ReturnType<typeof createSafetyServices>;
  effects: EffectRegistry;
  release: ReturnType<typeof createTenantFeatureRelease>;
}): {
  returnActions: ReturnActions;
  returnCases: ReturnCases;
  returnDeadlines: ReturnDeadlines;
  returnExchanges: ReturnExchanges;
} {
  const { database, identity, resolvable, safety, effects, release } = options;
  const returnCases: ReturnCases = createReturnCaseService(
    database,
    createAuditLog,
    {
      system: options.returns
        ? createReturnSystem(
            options.returns.runtime,
            options.returns.installations,
          )
        : null,
      admission: resolvable.has('return_creation')
        ? createReturnCreationAdmission(safety, effects)
        : null,
      refreshContext: identity.refreshContext,
      principal: identity.resolveWorkflowContext,
    },
  );
  const returnActions = createReturnActionService(database, createAuditLog, {
    system: options.returns
      ? createReturnSettlementSystem(options.returns.runtime)
      : null,
    admission: resolvable.has('return_settlement')
      ? createReturnSettlementAdmission(safety, effects)
      : null,
    describeDiff: async (context, action, observedAt, plan) =>
      (await release(context.tenantId, 'action-review-diffs'))
        ? describeActionDiff(action, observedAt, { plan })
        : null,
    refreshContext: identity.refreshContext,
    principal: identity.resolveWorkflowContext,
  });
  const returnExchanges = createReturnExchangeService(
    database,
    createAuditLog,
    {
      system: options.returns
        ? createReturnConsistencySystem(options.returns.runtime)
        : null,
      admission: resolvable.has('return_exchange')
        ? createReturnExchangeAdmission(safety, effects)
        : null,
      describeDiff: async (context, action, observedAt, plan) =>
        (await release(context.tenantId, 'action-review-diffs'))
          ? describeActionDiff(action, observedAt, { plan })
          : null,
      refreshContext: identity.refreshContext,
      principal: identity.resolveWorkflowContext,
    },
  );
  const returnDeadlines = createReturnDeadlineService(
    database,
    createAuditLog,
    {
      refreshContext: identity.refreshContext,
      // Without installed return connections, sent money cannot be read.
      source: createReturnMoneySource(
        options.returns
          ? {
              refund: (context, caseId, id) =>
                returnActions.observe(context, caseId, id),
              exchange: (context, caseId, id) =>
                returnExchanges.observe(context, caseId, id),
            }
          : null,
      ),
    },
  );

  return { returnActions, returnCases, returnDeadlines, returnExchanges };
}
