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
        'Orders with fulfillment work remaining. Partially fulfilled orders count once. Completed, canceled, and deleted orders don’t count.',
      predicate: 'open_remaining_quantity',
      timeSemantics:
        'Order data from your connected systems at the time shown.',
    },
    {
      id: 'orders.overdue',
      title: 'Overdue orders',
      description:
        'Open orders whose fulfillment deadline from the source system has passed. Orders without a deadline count as unknown.',
      predicate: 'open_and_due_before_as_of',
      timeSemantics:
        'Deadlines before the time shown. The count can change as time passes, even without new data.',
    },
    {
      id: 'orders.attention',
      title: 'Orders needing you',
      description:
        'Orders linked to an unresolved issue that waits for an approval, a manual fix, or a review of an unclear outcome. Each order counts once.',
      predicate: 'persisted_case_attention',
      timeSemantics:
        'Issues and order data from the same moment, at the time shown.',
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
