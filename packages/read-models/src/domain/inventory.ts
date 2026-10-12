export interface StockSource {
  /** Positive catalog evidence of a merchandising parent, separate from this stock read. */
  bundleContext?: { observedAt: string; componentCount: number | null } | null;
  connectionId: string;
  label: string;
  status: string;
  externalSku: string | null;
  externalLocation: string | null;
  mappingMethod: string | null;
  onHand: string | null;
  reserved: string | null;
  available: string | null;
  incoming: string | null;
  committed?: string | null;
  damaged?: string | null;
  qualityControl?: string | null;
  safetyStock?: string | null;
  locationActive?: boolean | null;
  itemActive?: boolean | null;
  tracked?: boolean | null;
  /** Versioned quantity meaning; absent for earlier or other provider reports. */
  inventorySemantics?: 'shopify/1' | null;
  /** Independently corroborated adjustment; other changes remain unattributed. */
  writeAttribution?: {
    evidenceId: string;
    adjustmentId: string;
    referenceDocumentUri: string;
    available: string;
    quantityMatches: boolean | null;
  } | null;
  availabilityBasis: 'provider_reported' | 'derived' | 'unknown';
  observedAt: string;
  sourceUpdatedAt: string | null;
  deleted: boolean;
}

export interface StockPosition {
  id: string;
  skuId: string;
  /** Readable SKU: a source SKU code when one is known, otherwise the canonical key. */
  sku: string;
  /** Canonical SKU reconciliation key; purchase order lines refer to it. */
  skuKey: string;
  locationId: string;
  location: string;
  unit: string;
  sources: StockSource[];
  differences: ('onHand' | 'reserved' | 'available')[];
  /**
   * A stock gap Luma is letting provider sync close: first seen at `since`, raised as an issue
   * if still open at `until`. Null when Luma is not waiting.
   */
  sync: { since: string; until: string } | null;
}

/** Normalizes decimal quantities without losing precision at the canonical six-decimal scale. */
export function stockDecimal(value: string): bigint {
  const negative = value.startsWith('-');
  const [whole, fraction = ''] = value.replace(/^-/, '').split('.');
  const amount = BigInt(whole!) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));

  return negative ? -amount : amount;
}

/** Compares known quantities of current sources for the same canonical position; missing is not zero. */
export function stockDifferences(sources: StockSource[]) {
  return (['onHand', 'reserved', 'available'] as const).filter((field) => {
    const quantities = new Map<string, Set<bigint>>();
    for (const source of sources) {
      const value = source[field];
      if (source.deleted || value === null) continue;
      const meaning =
        field === 'reserved' ? (source.inventorySemantics ?? 'legacy') : field;
      const values = quantities.get(meaning) ?? new Set<bigint>();
      values.add(stockDecimal(value));
      quantities.set(meaning, values);
    }

    return [...quantities.values()].some((values) => values.size > 1);
  });
}
