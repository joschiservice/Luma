/** The second bounded responsibility: explicit incident consent, independent of earned supplier autonomy. */
export interface StockProtectionConsent {
  connectionId: string;
  sourceConnectionId: string;
  revision: number;
  mode: 'off' | 'preview' | 'on';
  riskThreshold: number;
  includeSalesRate: boolean;
  bufferUnits: number;
  bufferPercent: number;
  keepSellable: number;
  maxSkus: number;
  maxUnitsPerSku: number;
  dailyUnits: number;
  maxDurationSeconds: number;
  durationAction: 'escalate' | 'release';
  exclusions: { skus: string[]; tags: string[]; collections: string[] };
}

/** Consent permits bounded downward holds or fresh-source releases; it never overrides a hard policy denial. */
export function admitsStockProtection(
  settings: StockProtectionConsent,
  facts: {
    operation: unknown;
    available: unknown;
    expected: unknown;
    revision: unknown;
    stopNew: boolean;
    positions: number;
  },
) {
  const { available, expected, operation } = facts;
  if (!['hold', 'tighten', 'release'].includes(String(operation))) return false;
  if (
    settings.revision !== facts.revision ||
    (operation === 'hold' && (settings.mode !== 'on' || facts.stopNew))
  )
    return false;
  if (
    typeof available !== 'number' ||
    typeof expected !== 'number' ||
    !Number.isSafeInteger(available) ||
    !Number.isSafeInteger(expected) ||
    available < 0 ||
    (operation !== 'release' && available >= expected)
  )
    return false;

  return (
    Math.abs(available - expected) <= settings.maxUnitsPerSku &&
    facts.positions <= settings.maxSkus
  );
}
