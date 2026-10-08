import { m } from '@luma/i18n/messages';

type Text = () => string;

/*
 * Operational metric definitions localized by metric ID: `metrics_<id>_title|description|
 * time_semantics`, with `.`, `:` and `-` replaced by `_`. Tests in each owning server package fail
 * when the English messages and the definitions differ. Metrics the client doesn't know yet keep
 * the server text.
 */
const metricText: Record<
  string,
  readonly [title: Text, description: Text, timeSemantics: Text]
> = {
  'cases.active': [
    m.metrics_cases_active_title,
    m.metrics_cases_active_description,
    m.metrics_cases_active_time_semantics,
  ],
  'cases.attention': [
    m.metrics_cases_attention_title,
    m.metrics_cases_attention_description,
    m.metrics_cases_attention_time_semantics,
  ],
  'cases.oldest_unresolved_age': [
    m.metrics_cases_oldest_unresolved_age_title,
    m.metrics_cases_oldest_unresolved_age_description,
    m.metrics_cases_oldest_unresolved_age_time_semantics,
  ],
  'orders.open': [
    m.metrics_orders_open_title,
    m.metrics_orders_open_description,
    m.metrics_orders_open_time_semantics,
  ],
  'orders.overdue': [
    m.metrics_orders_overdue_title,
    m.metrics_orders_overdue_description,
    m.metrics_orders_overdue_time_semantics,
  ],
  'orders.attention': [
    m.metrics_orders_attention_title,
    m.metrics_orders_attention_description,
    m.metrics_orders_attention_time_semantics,
  ],
  'procurement.purchase_orders.draft': [
    m.metrics_procurement_purchase_orders_draft_title,
    m.metrics_procurement_purchase_orders_draft_description,
    m.metrics_procurement_purchase_orders_draft_time_semantics,
  ],
  'procurement.purchase_orders.open': [
    m.metrics_procurement_purchase_orders_open_title,
    m.metrics_procurement_purchase_orders_open_description,
    m.metrics_procurement_purchase_orders_open_time_semantics,
  ],
  'inventory.below_minimum': [
    m.metrics_inventory_below_minimum_title,
    m.metrics_inventory_below_minimum_description,
    m.metrics_inventory_below_minimum_time_semantics,
  ],
  'inventory.replenishment_unknown': [
    m.metrics_inventory_replenishment_unknown_title,
    m.metrics_inventory_replenishment_unknown_description,
    m.metrics_inventory_replenishment_unknown_time_semantics,
  ],
  'connections.needing_attention': [
    m.metrics_connections_needing_attention_title,
    m.metrics_connections_needing_attention_description,
    m.metrics_connections_needing_attention_time_semantics,
  ],
  'resolution.unknown_eligibility': [
    m.metrics_resolution_unknown_eligibility_title,
    m.metrics_resolution_unknown_eligibility_description,
    m.metrics_resolution_unknown_eligibility_time_semantics,
  ],
  'resolution.eligible': [
    m.metrics_resolution_eligible_title,
    m.metrics_resolution_eligible_description,
    m.metrics_resolution_eligible_time_semantics,
  ],
  'resolution.verified': [
    m.metrics_resolution_verified_title,
    m.metrics_resolution_verified_description,
    m.metrics_resolution_verified_time_semantics,
  ],
  'resolution.autonomous': [
    m.metrics_resolution_autonomous_title,
    m.metrics_resolution_autonomous_description,
    m.metrics_resolution_autonomous_time_semantics,
  ],
  'resolution.human': [
    m.metrics_resolution_human_title,
    m.metrics_resolution_human_description,
    m.metrics_resolution_human_time_semantics,
  ],
  'resolution.unknown': [
    m.metrics_resolution_unknown_title,
    m.metrics_resolution_unknown_description,
    m.metrics_resolution_unknown_time_semantics,
  ],
  'resolution.pending': [
    m.metrics_resolution_pending_title,
    m.metrics_resolution_pending_description,
    m.metrics_resolution_pending_time_semantics,
  ],
  'resolution.recurrent': [
    m.metrics_resolution_recurrent_title,
    m.metrics_resolution_recurrent_description,
    m.metrics_resolution_recurrent_time_semantics,
  ],
  'resolution.incorrect_actions': [
    m.metrics_resolution_incorrect_actions_title,
    m.metrics_resolution_incorrect_actions_description,
    m.metrics_resolution_incorrect_actions_time_semantics,
  ],
  'resolution.time_to_outcome': [
    m.metrics_resolution_time_to_outcome_title,
    m.metrics_resolution_time_to_outcome_description,
    m.metrics_resolution_time_to_outcome_time_semantics,
  ],
  'resolution.unresolved_age': [
    m.metrics_resolution_unresolved_age_title,
    m.metrics_resolution_unresolved_age_description,
    m.metrics_resolution_unresolved_age_time_semantics,
  ],
};

type Definition = {
  id: string;
  title: string;
  description: string;
  timeSemantics: string;
};

const text = (id: string) =>
  Object.hasOwn(metricText, id) ? metricText[id] : undefined;

/** Returns a metric's title in the interface language, or the server's title. */
export function metricTitle(definition: Pick<Definition, 'id' | 'title'>) {
  return text(definition.id)?.[0]() ?? definition.title;
}

/** Returns what a metric counts in the interface language, or the server's description. */
export function metricDescription(
  definition: Pick<Definition, 'id' | 'description'>,
) {
  return text(definition.id)?.[1]() ?? definition.description;
}

/** Returns when a metric is evaluated in the interface language, or the server's text. */
export function metricTimeSemantics(
  definition: Pick<Definition, 'id' | 'timeSemantics'>,
) {
  return text(definition.id)?.[2]() ?? definition.timeSemantics;
}
