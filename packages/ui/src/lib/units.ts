import { formattingLocale } from '@luma/i18n/format';
import { m } from '@luma/i18n/messages';

// Source systems spell "one piece" in several ways (Luma's `each`, JTL's `Stk`/`Stück`, `pcs`).
// Only these are translated; any other unit, such as `kg` or `box`, is shown as delivered.
const pieceUnits = new Set([
  'each',
  'ea',
  'pc',
  'pcs',
  'piece',
  'pieces',
  'stk',
  'stück',
  'unit',
  'units',
]);

/** Tells whether a source unit means single pieces, such as `each`, `pcs` or `Stk`. */
export function isPieceUnit(unit: string): boolean {
  return pieceUnits.has(unit.trim().toLowerCase());
}

/**
 * Names a unit for a specific quantity, for sentences and quantity cells such as “12 units”
 * or “12 Stück”. Piece units (`each`, `pcs`, `Stk`…) become the singular or plural word for the
 * quantity in the interface language; any other unit is returned unchanged. A quantity that
 * isn’t a finite number uses the plural word.
 */
export function quantityUnit(unit: string, quantity: number | string): string {
  if (!isPieceUnit(unit)) return unit;
  const value = Math.abs(Number(quantity));
  const plural = Number.isFinite(value)
    ? new Intl.PluralRules(formattingLocale()).select(value)
    : 'other';

  return plural === 'one' ? m.ui_unit_piece_one() : m.ui_unit_piece_other();
}

/**
 * Names a unit of measure without a quantity, for labels such as “Tokyo warehouse · units”.
 * Piece units become “units” (“Stück”); any other unit is returned unchanged.
 */
export function unitOfMeasure(unit: string): string {
  return isPieceUnit(unit) ? m.ui_unit_of_measure_piece() : unit;
}

/**
 * Joins an already formatted quantity with its unit, such as “12 units” or “1,5 kg”. Pass the
 * raw quantity as `value` so the unit word agrees with it.
 */
export function quantityWithUnit(
  formatted: string,
  unit: string,
  value: number | string,
): string {
  return m.ui_quantity_with_unit({
    quantity: formatted,
    unit: quantityUnit(unit, value),
  });
}
