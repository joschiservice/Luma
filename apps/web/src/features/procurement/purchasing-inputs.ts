import { m } from '@luma/i18n/messages';

const labels: Record<string, () => string> = {
  incoming_incomplete: m.purchasing_missing_incoming,
  terms_incomplete: m.purchasing_missing_terms_incomplete,
  terms_stale: m.purchasing_missing_terms_stale,
  stock_missing: m.purchasing_missing_stock,
  stock_authority: m.purchasing_missing_authority,
  stock_incomplete: m.purchasing_missing_stock_incomplete,
  stock_stale: m.purchasing_missing_stock_stale,
  unit_mismatch: m.purchasing_missing_units,
  pack_size: m.purchasing_missing_pack,
  minimum_quantity: m.purchasing_missing_minimum,
  demand_incomplete: m.purchasing_missing_demand,
  lead_time: m.purchasing_missing_lead,
  quantity_limit: m.purchasing_missing_limit,
  inputs_missing: m.purchasing_missing_inputs,
  open_order: m.purchasing_missing_open_order,
};

/** Explains missing purchasing evidence in the active language without exposing internal field codes. */
export function purchasingMissingLabel(reason: string): string {
  return (labels[reason] ?? m.purchasing_missing_inputs)();
}
