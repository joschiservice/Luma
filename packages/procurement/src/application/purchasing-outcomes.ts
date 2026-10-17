import type { TenantContext } from '@luma/identity';
import { requirePermission, requireTenant } from '@luma/identity';
import { conflict, forbidden } from '@luma/platform';

import type { PurchasingOverview } from '../domain/purchasing.js';
import type {
  PurchasingIgnore,
  PurchasingOutcomeList,
} from '../domain/purchasing-outcomes.js';

/** Records an explicit ignored recommendation and serves only independently observed outcomes. */
export function createPurchasingOutcomes(deps: {
  parse(input: unknown): PurchasingIgnore;
  refreshContext(context: TenantContext): Promise<TenantContext>;
  enabled(context: TenantContext): Promise<boolean>;
  overview(context: TenantContext): Promise<PurchasingOverview>;
  existing(context: TenantContext, request: PurchasingIgnore): Promise<boolean>;
  ignore(
    context: TenantContext,
    request: PurchasingIgnore,
    recommendation: PurchasingOverview['items'][number],
  ): Promise<void>;
  read(context: TenantContext): Promise<Omit<PurchasingOutcomeList, 'enabled'>>;
}) {
  async function authorize(context: TenantContext, write = false) {
    const fresh = await deps.refreshContext(context);
    requireTenant(fresh, context.tenantId);
    if (fresh.actor.id !== context.actor.id)
      throw forbidden('Sign in again to continue.');
    requirePermission(fresh, write ? 'procurement.manage' : 'procurement.read');
    requirePermission(fresh, 'inventory.read');

    return fresh;
  }

  return {
    /** Reads outcomes by supplier and product; unknowns remain outside verified totals. */
    async read(context: TenantContext): Promise<PurchasingOutcomeList> {
      context = await authorize(context);
      const enabled = await deps.enabled(context);

      return enabled
        ? { enabled, ...(await deps.read(context)) }
        : {
            enabled,
            items: [],
            summary: { verifiedAvailable: 0, stockouts: 0, unknown: 0 },
            truncated: false,
            asOf: new Date().toISOString(),
          };
    },
    /** Saves the server's current recommendation, never a client-supplied evidence snapshot. */
    async ignore(context: TenantContext, input: unknown) {
      context = await authorize(context, true);
      if (!(await deps.enabled(context)))
        throw conflict('Purchasing outcomes are not enabled.');
      const request = deps.parse(input);
      if (await deps.existing(context, request))
        return { recorded: true as const };
      const view = await deps.overview(context);
      const rec = view.items.find(
        (r) => r.supplierId === request.supplierId && r.skuId === request.skuId,
      );
      if (
        !rec ||
        rec.quantity === null ||
        rec.quantity <= 0 ||
        rec.missing.length
      )
        throw conflict('Refresh and review an available recommendation.');
      await deps.ignore(context, request, rec);

      return { recorded: true as const };
    },
  };
}

export type PurchasingOutcomes = ReturnType<typeof createPurchasingOutcomes>;
