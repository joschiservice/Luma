/** Describes a versioned current-state metric and its authorized cohort. */
export interface OperationalMetricDefinition {
  id: string;
  title: string;
  description: string;
  version: 2;
  unit: 'case' | 'second' | 'stock_position' | 'purchase_order' | 'connection';
  family: 'cases' | 'inventory' | 'procurement' | 'connections';
  filters: readonly string[];
  timeSemantics: string;
  permissions: 'workspace_member';
}

/** A domain-owned cohort before transport pagination; counts always cover the full cohort. */
export interface OperationalMetricRead<Item> {
  definition: OperationalMetricDefinition;
  value: number | null;
  total: number | null;
  observedCount: number;
  unknownCount: number;
  population: number;
  coverage: 'complete' | 'partial' | 'unavailable';
  coverageExplanation: string;
  freshness: 'fresh' | 'stale' | 'unobserved';
  observedAt: string | null;
  dataThrough: string | null;
  nextRefreshAt: string | null;
  breakdown: { reason: string; count: number }[];
  items: Item[];
}
