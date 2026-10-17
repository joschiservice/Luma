import { orderValue } from './order-value.js';
import type { PurchasingDemand } from './purchasing.js';
import type { SupplierProductTerms } from './supplier-terms.js';

/** @public Declaration emit names this context in replenishment service results.
 * Commercial facts frozen with the governed proposal; null fields are unavailable, never zero. */
export interface ReplenishmentApprovalContext {
  productTitle: string | null;
  unitPrice: { amount: string; currency: string } | null;
  totalValue: { amount: string; currency: string } | null;
  leadTimeDays: number | null;
  dailySales: number | null;
  demandPeriodDays: number;
  coverBeforeDays: number | null;
  coverAfterDays: number | null;
  openOrders: {
    id: string;
    reference: string;
    quantity: number;
    status: string;
  }[];
  termsSource: string | null;
  termsObservedAt: string | null;
  demandObservedAt: string | null;
  /**
   * The order reads behind `dailySales`, at most 100; empty when demand is unknown. Contexts
   * frozen before Luma recorded them have none.
   */
  demandEvidenceRefs?: string[];
  recordedAt: string;
  unavailable: string[];
}

/** Freezes explainable estimates; stale terms or incomplete demand never become known business facts. */
export function replenishmentReviewContext(input: {
  productTitle: string | null;
  terms: SupplierProductTerms | null;
  demand: PurchasingDemand | null;
  available: number | null;
  quantity: number;
  openOrders: ReplenishmentApprovalContext['openOrders'] | null;
  now: string;
}): ReplenishmentApprovalContext {
  const { terms, demand, now } = input;
  const readAt = terms?.lastReadAt ?? terms?.observed?.observedAt ?? null;
  const age = readAt ? Date.parse(now) - Date.parse(readAt) : null;
  const fresh =
    !!terms &&
    (terms.lastReadComplete ?? terms.observed?.complete) &&
    age !== null &&
    age >= 0 &&
    age < 86_400_000;
  const manualPrice = terms?.history.some(
    (version) =>
      version.source === 'manual' &&
      version.values.unitPrice != null &&
      (!version.values.unitPrice.validFrom ||
        version.values.unitPrice.validFrom <= now.slice(0, 10)),
  );
  const manualLeadTime = terms?.history.some(
    (version) =>
      version.source === 'manual' && version.values.leadTimeDays !== undefined,
  );
  const unitPrice =
    (fresh || manualPrice) && terms?.effective.unitPrice?.currency
      ? {
          amount: terms.effective.unitPrice.amount,
          currency: terms.effective.unitPrice.currency,
        }
      : null;
  const leadTimeDays =
    fresh || manualLeadTime ? (terms?.effective.leadTimeDays ?? null) : null;
  const dailySales =
    demand?.complete && demand.daily !== null && demand.daily >= 0
      ? demand.daily
      : null;
  const total = unitPrice
    ? orderValue({
        lines: [
          {
            id: 'review',
            sku: '',
            description: '',
            quantity: input.quantity,
            unit: '',
            unitPrice,
          },
        ],
      })
    : null;
  const cover = (available: number | null) =>
    available !== null && dailySales !== null && dailySales > 0
      ? Math.max(0, available) / dailySales
      : null;

  return {
    productTitle: input.productTitle,
    unitPrice,
    totalValue: total && total !== 'unknown' ? total : null,
    leadTimeDays,
    dailySales,
    demandPeriodDays: demand?.periodDays ?? 30,
    coverBeforeDays: cover(input.available),
    coverAfterDays: cover(
      input.available === null ? null : input.available + input.quantity,
    ),
    openOrders: input.openOrders?.slice(0, 100) ?? [],
    termsSource:
      unitPrice || leadTimeDays !== null
        ? manualPrice || manualLeadTime
          ? 'Reviewed supplier terms'
          : 'Connected supplier terms'
        : null,
    termsObservedAt:
      manualPrice || manualLeadTime
        ? (terms?.override?.observedAt ?? readAt)
        : readAt,
    demandObservedAt: demand?.observedAt ?? null,
    demandEvidenceRefs:
      dailySales === null
        ? []
        : [...new Set(demand?.evidenceRefs ?? [])].slice(0, 100),
    recordedAt: now,
    unavailable: [
      ...(!unitPrice ? ['unit_price'] : []),
      ...(!leadTimeDays && leadTimeDays !== 0 ? ['lead_time'] : []),
      ...(dailySales === null ? ['demand'] : []),
      ...(input.openOrders === null ? ['open_orders'] : []),
      ...((input.openOrders?.length ?? 0) > 100
        ? ['open_orders_truncated']
        : []),
    ],
  };
}
