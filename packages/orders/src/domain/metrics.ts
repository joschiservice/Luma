export const orderMetricIds = [
  'orders.open',
  'orders.overdue',
  'orders.attention',
] as const;

export type OrderMetricId = (typeof orderMetricIds)[number];

/** Versioned definitions for counting distinct canonical orders, shared by every consumer. */
export const orderMetricDefinitions = (
  [
    {
      id: 'orders.open',
      title: 'Open orders',
      description:
        'Orders with remaining fulfillment work. Partially fulfilled orders count once; completed, cancelled and deleted orders do not count.',
      predicate: 'open_remaining_quantity',
      timeSemantics: 'Current accepted source state at the read snapshot.',
    },
    {
      id: 'orders.overdue',
      title: 'Overdue orders',
      description:
        'Open orders whose source-provided fulfillment deadline is before the evaluation time. Orders without a deadline are unknown.',
      predicate: 'open_and_due_before_as_of',
      timeSemantics:
        'dueAt < asOf. Time passing can change this count without a source update.',
    },
    {
      id: 'orders.attention',
      title: 'Orders needing you',
      description:
        'Orders linked to an unresolved issue that requests approval, manual intervention or uncertainty review. Each order counts once.',
      predicate: 'persisted_case_attention',
      timeSemantics:
        'Inbox attention evaluated at the same read snapshot and evaluation time.',
    },
  ] as const
).map((definition) => ({
  ...definition,
  version: 1 as const,
  unit: 'canonical_order' as const,
  dimensions: ['connectionId'] as const,
  filters: ['connectionId', 'updatedFrom', 'updatedBefore'] as const,
  permissions: 'workspace_member' as const,
  drillDown: 'orders.cohort' as const,
}));
