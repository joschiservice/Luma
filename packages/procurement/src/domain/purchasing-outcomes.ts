export interface OutcomeStockRead {
  observationId: string;
  observedAt: string;
  available: number | null;
  complete: boolean;
}

/** Reports observed outcomes; incomplete history never proves a stockout was prevented. */
export function evaluatePurchasingOutcome(input: {
  decidedAt: string;
  decision: 'followed' | 'changed' | 'ignored';
  receipt: {
    observedAt: string;
    verified: boolean;
    evidenceRefs: string[];
  } | null;
  stocks: OutcomeStockRead[];
  target: number | null;
  now: number;
}) {
  const start = Date.parse(input.decidedAt);
  const receiptAt = input.receipt?.verified
    ? Date.parse(input.receipt.observedAt)
    : null;
  const until = receiptAt ?? input.now;
  const stocks = input.stocks
    .filter(
      (s) =>
        Date.parse(s.observedAt) >= start &&
        Date.parse(s.observedAt) <= input.now,
    )
    .sort((a, b) => a.observedAt.localeCompare(b.observedAt));
  const beforeReceipt = stocks.filter((s) => Date.parse(s.observedAt) <= until);
  const complete =
    beforeReceipt.length > 0 &&
    beforeReceipt.every(
      (s, i) =>
        s.complete &&
        s.available !== null &&
        Number.isFinite(s.available) &&
        Date.parse(s.observedAt) -
          (i ? Date.parse(beforeReceipt[i - 1]!.observedAt) : start) <=
          300_000,
    ) &&
    until - Date.parse(beforeReceipt.at(-1)!.observedAt) <= 300_000;
  const stockout = stocks.find(
    (s) => s.complete && s.available !== null && s.available <= 0,
  );
  const after =
    receiptAt === null
      ? undefined
      : stocks.find(
          (s) =>
            s.complete &&
            s.available !== null &&
            Date.parse(s.observedAt) >= receiptAt &&
            Date.parse(s.observedAt) - receiptAt <= 300_000,
        );
  const timely =
    input.receipt?.verified &&
    complete &&
    !beforeReceipt.some((s) => s.available! <= 0) &&
    !!after &&
    after.available! > 0;
  const state = stockout
    ? ('stockout_observed' as const)
    : timely
      ? ('available_through_receipt' as const)
      : ('unknown' as const);
  let zeroDurationMs: number | null = null;
  if (stockout) {
    const first = stocks.indexOf(stockout);
    const run = stocks.slice(first);
    const end = run.findIndex(
      (s) => s.complete && s.available !== null && s.available > 0,
    );
    const interval = end >= 0 ? run.slice(0, end + 1) : run;
    if (
      interval.length > 1 &&
      interval.every(
        (s, i) =>
          s.complete &&
          s.available !== null &&
          (!i ||
            Date.parse(s.observedAt) -
              Date.parse(interval[i - 1]!.observedAt) <=
              300_000),
      )
    )
      zeroDurationMs =
        Date.parse(interval.at(-1)!.observedAt) -
        Date.parse(stockout.observedAt);
  }

  return {
    state,
    stockoutAt: stockout?.observedAt ?? null,
    observedStockoutMinutes:
      zeroDurationMs === null ? null : zeroDurationMs / 60_000,
    aboveTarget:
      after && input.target !== null
        ? Math.max(0, after.available! - input.target)
        : null,
    receiptAt: receiptAt === null ? null : input.receipt!.observedAt,
    complete,
    evidenceRefs: [
      ...new Set([
        ...stocks.filter((s) => s.complete).map((s) => s.observationId),
        ...(input.receipt?.verified ? input.receipt.evidenceRefs : []),
      ]),
    ],
    reason:
      state === 'unknown'
        ? !input.receipt?.verified && input.decision !== 'ignored'
          ? 'receipt_unverified'
          : 'stock_history_incomplete'
        : null,
  };
}

/** An explicit human decision to ignore a current server recommendation. */
export interface PurchasingIgnore {
  id: string;
  supplierId: string;
  skuId: string;
  reason: string;
}

/** Observed consequences remain separate from the recommendation decision. */
export interface PurchasingOutcome {
  id: string;
  supplierId: string;
  supplierName: string;
  skuId: string;
  sku: string;
  locationId: string;
  suggested: number | null;
  chosen: number | null;
  decision: 'followed' | 'changed' | 'ignored';
  decidedAt: string;
  orderId: string | null;
  state: 'unknown' | 'stockout_observed' | 'available_through_receipt';
  stockoutAt: string | null;
  observedStockoutMinutes: number | null;
  aboveTarget: number | null;
  receiptAt: string | null;
  complete: boolean;
  evidenceRefs: string[];
  reason: string | null;
}

export interface PurchasingOutcomeList {
  enabled: boolean;
  items: PurchasingOutcome[];
  summary: { verifiedAvailable: number; stockouts: number; unknown: number };
  truncated: boolean;
  asOf: string;
}
