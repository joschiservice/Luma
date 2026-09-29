import type { StockPosition, StockSource } from '@luma/api-contract';
import { StatePill } from '@luma/ui/components/primitives/state';

/** Formats a reported quantity without rounding; null remains visibly unknown. */
export function stockQuantity(value: string | null) {
  return value === null ? 'Unknown' : value;
}

/** Explains whether the same mapped position has known conflicting quantities. */
export function StockState({ position }: { position: StockPosition }) {
  if (position.differences.length)
    return <StatePill state="attention">Differs by source</StatePill>;
  if (position.sources.every((source) => source.deleted))
    return <StatePill state="idle">Removed at source</StatePill>;
  if (
    position.sources.some(
      (source) =>
        source.deleted ||
        source.available === null ||
        source.onHand === null ||
        source.reserved === null,
    )
  )
    return <StatePill state="waiting">Incomplete stock</StatePill>;

  return (
    <StatePill state="idle">
      {position.sources.length > 1 ? 'Known quantities agree' : 'One source'}
    </StatePill>
  );
}

/** Labels observation age independently of source update time and connection health. */
export function stockFreshness(source: StockSource, asOf: string) {
  if (source.deleted) return 'Removed at source';
  const age = Date.parse(asOf) - Date.parse(source.observedAt);
  if (age < 0) return 'Observation time is ahead';
  if (age >= 3_600_000) return `Observed ${Math.floor(age / 3_600_000)}h ago`;
  if (age >= 60_000) return `Observed ${Math.floor(age / 60_000)}m ago`;

  return 'Observed just now';
}
