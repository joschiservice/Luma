import type { StockPosition, StockSource } from '@luma/api-contract';
import { formatList, formatRelativeTime } from '@luma/i18n/format';
import { m } from '@luma/i18n/messages';
import { StatePill } from '@luma/ui/components/primitives/state';

import { formatSourceNumber } from '../../shared/orders/presentation';

type StockField = 'onHand' | 'reserved' | 'available' | 'incoming';

/** Column labels for each reported quantity. */
export const quantityLabels: Record<StockField, () => string> = {
  onHand: m.inventory_quantity_on_hand,
  reserved: m.inventory_quantity_reserved,
  available: m.inventory_quantity_available,
  incoming: m.inventory_quantity_incoming,
};

const quantityNames: Record<
  StockPosition['differences'][number],
  () => string
> = {
  onHand: m.inventory_quantity_on_hand_in_sentence,
  reserved: m.inventory_quantity_reserved_in_sentence,
  available: m.inventory_quantity_available_in_sentence,
};

/** Names the quantities that differ between sources as a list for a sentence. */
export function differingQuantities(fields: StockPosition['differences']) {
  return formatList(fields.map((field) => quantityNames[field]()));
}

/**
 * Formats a reported quantity in the active language without rounding. A missing value shows as
 * not reported, never as zero.
 */
export function stockQuantity(value: string | null) {
  return value === null ? m.common_not_reported() : formatSourceNumber(value);
}

/** Explains whether the same linked position has known conflicting quantities. */
export function StockState({ position }: { position: StockPosition }) {
  if (position.differences.length)
    return (
      <StatePill state="attention">{m.inventory_state_differs()}</StatePill>
    );
  if (position.sources.every((source) => source.deleted))
    return <StatePill state="idle">{m.inventory_state_removed()}</StatePill>;
  if (
    position.sources.some(
      (source) =>
        source.deleted ||
        source.available === null ||
        source.onHand === null ||
        source.reserved === null,
    )
  )
    return (
      <StatePill state="waiting">{m.inventory_state_incomplete()}</StatePill>
    );

  return (
    <StatePill state="idle">
      {position.sources.length > 1
        ? m.inventory_state_agree()
        : m.inventory_state_one_source()}
    </StatePill>
  );
}

/** Labels how long ago Luma read a source, independently of source update time and connection health. */
export function stockFreshness(source: StockSource, asOf: string) {
  if (source.deleted) return m.inventory_state_removed();
  const age = Date.parse(asOf) - Date.parse(source.observedAt);
  if (age < 0) return m.inventory_read_time_unclear();
  if (age < 60_000) return m.inventory_read_just_now();

  return m.inventory_read_ago({
    time: formatRelativeTime(source.observedAt, asOf),
  });
}
