import type { StockProtectionSettings } from '@luma/api-contract';

/** Fresh, exact-mapped position facts. Unknown eligibility is excluded rather than guessed. */
export interface ProtectionCandidate {
  positionId: string;
  skuId: string;
  sku: string | null;
  title: string | null;
  available: number | null;
  authority: number | null;
  tracked: boolean;
  inventoryPolicy: 'DENY' | 'CONTINUE' | null;
  bundle: boolean | null;
  native: boolean;
  unsettled: boolean;
  complete: boolean;
  tags: string[];
  collections: string[];
  sales24h: number | null;
}

/** Computes a bounded downward change; keepSellable can never increase the current quantity. */
export function heldQuantity(
  available: number,
  authority: number,
  settings: StockProtectionSettings,
) {
  const base = Math.max(0, Math.min(available, authority));
  const buffer = Math.max(
    settings.bufferUnits,
    Math.ceil((base * settings.bufferPercent) / 100),
  );

  return Math.min(available, Math.max(settings.keepSellable, base - buffer));
}

/** Gives every excluded position a stable reason; only fresh known eligibility permits a hold. */
export function protectionExclusion(
  candidate: ProtectionCandidate,
  settings: StockProtectionSettings,
): string | null {
  if (!candidate.complete) return 'incomplete';
  if (!candidate.tracked) return 'untracked';
  if (candidate.inventoryPolicy !== 'DENY')
    return candidate.inventoryPolicy === 'CONTINUE'
      ? 'continue_selling'
      : 'eligibility_unknown';
  if (candidate.bundle !== false)
    return candidate.bundle ? 'bundle' : 'eligibility_unknown';
  if (candidate.native) return 'native_stock';
  if (candidate.unsettled) return 'active_correction';
  if (
    (candidate.sku && settings.exclusions.skus.includes(candidate.sku)) ||
    candidate.tags.some((tag) => settings.exclusions.tags.includes(tag)) ||
    candidate.collections.some((id) =>
      settings.exclusions.collections.includes(id),
    )
  )
    return 'excluded';
  if (
    ![candidate.available, candidate.authority].every(
      (value) => value !== null && Number.isSafeInteger(value) && value >= 0,
    )
  )
    return 'quantity_unknown';
  if (
    candidate.available! > settings.riskThreshold &&
    !(
      settings.includeSalesRate &&
      candidate.sales24h !== null &&
      candidate.sales24h > candidate.available!
    )
  )
    return 'not_at_risk';
  const held = heldQuantity(
    candidate.available!,
    candidate.authority!,
    settings,
  );
  if (held >= candidate.available!) return 'no_reduction';
  if (candidate.available! - held > settings.maxUnitsPerSku) return 'unit_cap';

  return null;
}

/** Selects the smallest stock cover first and uses stable position IDs to break ties. */
export function selectProtection(
  candidates: ProtectionCandidate[],
  settings: StockProtectionSettings,
) {
  let count = 0;

  return [...candidates]
    .sort(
      (a, b) =>
        (a.available ?? Infinity) - (b.available ?? Infinity) ||
        a.positionId.localeCompare(b.positionId),
    )
    .map((candidate) => {
      const reason =
        protectionExclusion(candidate, settings) ??
        (++count > settings.maxSkus ? 'sku_cap' : null);

      return {
        candidate,
        reason,
        held: reason
          ? null
          : heldQuantity(candidate.available!, candidate.authority!, settings),
      };
    });
}

/** A fresh outside quantity ends ownership permanently for this incident. */
export function outsideHold(
  current: number,
  held: number,
  authority: number,
): 'released_by_sync' | 'changed_outside_luma' | null {
  if (current === held) return null;

  return current === authority ? 'released_by_sync' : 'changed_outside_luma';
}
