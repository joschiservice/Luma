/**
 * SQL building blocks that define current order selection and order state under
 * `orderMetricDefinitions` v1. Readers compose them inside their own read transaction so
 * every view classifies an order the same way. Fragments expect `$1` to be the tenant ID
 * and `$2` the evaluation time.
 */
export interface OrderStateQueries {
  /** `ORDER BY` terms that pick one current source per canonical order. */
  sourceSelectionOrder: string;
  /** SQL predicate for a source_differences row aliased d. */
  anyDifference: string;
  /** Read-time comparison state for an orders_list row with the supplied SQL alias. */
  comparisonState(alias: string): string;
  /** Compares known source facts for the entity_id values in the named relation. */
  sourceComparison(sources: string, entities: string): string;
  /** Returns a CTE named `name` with every current order snapshot, one row per source. */
  currentOrderSources(name: string, filter?: string): string;
  /** Returns the `order_line_progress` and `order_state` CTEs over the order sources in `set`. */
  orderProgress(set: string): string;
}
