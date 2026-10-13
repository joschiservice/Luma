import type { TenantContext } from '@luma/identity';

import type { ProcurementService } from '../application/procurement.js';
import type { SupplierTermsService } from '../application/supplier-terms.js';
import type { IncomingStock } from '../domain/incoming.js';
import type {
  PurchasingOverview,
  PurchasingSettings,
} from '../domain/purchasing.js';
import { recommendPurchase } from '../domain/purchasing.js';
import type { createPurchasingInputs } from './purchasing-inputs.js';

/** Groups supplier terms and independently sourced stock without summing competing sources. */
export function createPurchasingOverview(deps: {
  terms: Pick<SupplierTermsService, 'list'>;
  procurement: Pick<ProcurementService, 'orders'>;
  inputs: ReturnType<typeof createPurchasingInputs>;
  incoming(
    context: TenantContext,
    input: { skuIds: string[] },
  ): Promise<Omit<IncomingStock, 'enabled'>>;
}) {
  return async (
    context: TenantContext,
    settings: PurchasingSettings,
  ): Promise<
    Omit<PurchasingOverview, 'enabled' | 'plansEnabled' | 'canManage'>
  > => {
    const [terms, orders] = await Promise.all([
      deps.terms.list(context, {}),
      deps.procurement.orders(context),
    ]);
    const items = terms.items.slice(0, 250);
    const skuIds = [...new Set(items.map((t) => t.skuId))];
    const [facts, arrivals] = await Promise.all([
      deps.inputs(context, skuIds, settings),
      skuIds.length
        ? deps.incoming(context, { skuIds })
        : Promise.resolve({
            items: [],
            truncated: false,
            supplierOrdersUnavailable: false,
            unavailableNativeIncoming: false,
            asOf: new Date().toISOString(),
          }),
    ]);
    const now = Date.now();
    const locations = new Map<string, string>();
    for (const s of facts.stocks) locations.set(s.locationId, s.location);
    const recommendations = items.map((t) => {
      const allStocks = facts.stocks.filter((s) => s.skuId === t.skuId);
      const stocks = allStocks.filter((s) => s.authoritative);
      const selected = stocks.length ? stocks : allStocks;
      const aliases = new Set([t.skuId, t.sku, ...selected.map((s) => s.sku)]);
      const existingOrders = orders.items
        .filter(
          (o) =>
            ['draft', 'open'].includes(o.status) &&
            o.lines.some((l) => aliases.has(l.sku)),
        )
        .map((o) => ({
          id: o.id,
          reference: o.reference,
          status: o.status as 'draft' | 'open',
          quantity: o.lines
            .filter((l) => aliases.has(l.sku))
            .reduce((sum, l) => sum + l.quantity, 0),
        }));
      const rules = selected.map((s) =>
        facts.rules.find((r) => r.positionId === s.positionId),
      );
      const rule =
        rules.length && rules.every((r) => r !== undefined)
          ? {
              minimum: rules.reduce((n, r) => n + r!.minimum, 0),
              target: rules.reduce((n, r) => n + r!.target, 0),
            }
          : null;
      const demand = facts.demand.get(t.skuId) ?? {
        daily: null,
        units: null,
        periodDays: settings.demandPeriodDays,
        observedAt: null,
        evidenceRefs: [],
        complete: false,
      };
      const incoming = arrivals.items.filter(
        (a) =>
          a.skuId === t.skuId &&
          (settings.locationIds.length === 0 ||
            !a.locationId ||
            settings.locationIds.includes(a.locationId)),
      );
      const incomingUsable =
        !arrivals.truncated &&
        !arrivals.supplierOrdersUnavailable &&
        !arrivals.unavailableNativeIncoming &&
        incoming.every(
          (a) =>
            a.freshness === 'fresh' &&
            a.locationId !== null &&
            selected.some(
              (st) => st.locationId === a.locationId && st.unit === a.unit,
            ),
        );
      const incomingQuantity = incomingUsable
        ? incoming.reduce((sum, a) => sum + a.quantity, 0)
        : null;
      const result = recommendPurchase({
        stocks: selected,
        demand,
        leadTimeDays: t.effective.leadTimeDays,
        packSize: t.effective.packSize,
        minimumQuantity: t.effective.lineMinimumQuantity,
        safetyDays: settings.safetyDays,
        committed: existingOrders.length > 0,
        incomingQuantity: incomingQuantity ?? 0,
        rule,
        now,
      });
      if (!incomingUsable) result.missing.push('incoming_incomplete');

      // A single overridden field cannot make unrelated provider terms fresh.
      const manualFields = new Set(
        t.history
          .filter((version) => version.source === 'manual')
          .flatMap((version) =>
            Object.keys(version.values).filter(
              (key) =>
                key !== 'unitPrice' ||
                !version.values.unitPrice?.validFrom ||
                version.values.unitPrice.validFrom <=
                  new Date(now).toISOString().slice(0, 10),
            ),
          ),
      );
      const requiredFields = [
        'packSize',
        'lineMinimumQuantity',
        ...(!rule ? ['leadTimeDays'] : []),
        ...(t.effective.unitPrice ? ['unitPrice'] : []),
        ...(t.effective.supplierArticleNumber ? ['supplierArticleNumber'] : []),
        ...(t.effective.orderMinimumValue ? ['orderMinimumValue'] : []),
      ];
      const providerRequired =
        !!t.observed &&
        requiredFields.some((field) => !manualFields.has(field));
      const providerReadAt = t.lastReadAt ?? t.observed?.observedAt ?? null;
      if (providerRequired && !(t.lastReadComplete ?? t.observed!.complete))
        result.missing.push('terms_incomplete');
      const providerAge =
        providerReadAt === null ? null : now - Date.parse(providerReadAt);
      if (
        providerRequired &&
        (providerAge === null ||
          !Number.isFinite(providerAge) ||
          providerAge < 0 ||
          providerAge > 86_400_000)
      )
        result.missing.push('terms_stale');
      const termsObservedAt = providerRequired
        ? providerReadAt
        : (t.override?.observedAt ?? providerReadAt);

      return {
        key: `${t.supplierId}:${t.skuId}`,
        supplierId: t.supplierId,
        supplierName: t.supplierName,
        skuId: t.skuId,
        sku: t.sku,
        termsRevision: t.revision,
        termsObservedAt,
        packSize: t.effective.packSize,
        minimumQuantity: t.effective.lineMinimumQuantity,
        leadTimeDays: t.effective.leadTimeDays,
        supplierArticleNumber: t.effective.supplierArticleNumber,
        unitPrice: t.effective.unitPrice?.currency
          ? {
              amount: t.effective.unitPrice.amount,
              currency: t.effective.unitPrice.currency,
            }
          : null,
        orderMinimumValue: t.effective.orderMinimumValue,
        stocks: selected,
        incoming,
        incomingQuantity,
        demand,
        existingOrders,
        rule,
        ...result,
        quantity: result.missing.length ? null : result.quantity,
      };
    });

    return {
      settings,
      items: recommendations,
      locations: [...locations].map(([id, name]) => ({ id, name })),
      asOf: new Date(now).toISOString(),
      truncated:
        terms.items.length > 250 || facts.truncated || arrivals.truncated,
    };
  };
}
