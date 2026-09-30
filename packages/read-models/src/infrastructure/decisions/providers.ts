import type { TenantContext } from '@luma/identity';

import type {
  AppOwnedDecision,
  DecisionProvider,
  ReplenishmentDecisionReader,
} from '../../application/decisions.js';
import { presentReplenishment } from '../../domain/decisions.js';

/** Adapts the procurement owner's pending purchase-order proposals to the queue. */
export function replenishmentDecisionProvider(
  pending: ReplenishmentDecisionReader,
): DecisionProvider {
  return {
    id: 'replenishment',
    label: 'Replenishment',
    pending: async (context) =>
      (await pending(context)).map((item) =>
        presentReplenishment(item, context.actor.id),
      ),
  };
}

/** Adapts an app's decisions. The app ID lets the host mount the app's own review. */
export function appDecisionProvider(app: {
  appId: string;
  name: string;
  decisions(context: TenantContext): Promise<AppOwnedDecision[]>;
}): DecisionProvider {
  return {
    id: `app:${app.appId}`,
    label: app.name,
    pending: async (context) =>
      (await app.decisions(context)).map((item) => ({
        ...item,
        owner: { ...item.owner, appId: app.appId },
      })),
  };
}
