import type {
  OperationalMetricDefinition,
  OperationalMetricRead,
} from '@luma/platform';

import type { ConnectionCoverage } from './coverage.js';

export interface ConnectionMetricItem extends ConnectionCoverage {
  kind: 'connection';
  reasons: string[];
}

export const connectionMetricDefinitions: OperationalMetricDefinition[] = [
  {
    id: 'connections.needing_attention',
    title: 'Connections needing attention',
    version: 2,
    family: 'connections',
    unit: 'connection',
    filters: ['connectionId'],
    permissions: 'workspace_member',
    description:
      'Installed connections that are pending, degraded, revoked, or active with stale or unobserved permitted reads. Disconnected installations are excluded. Each connection counts once.',
    timeSemantics:
      'Current installation health and permitted granted reads at asOf. Exactly 24 hours old remains fresh.',
  },
];

/** Counts each problematic connection once, preserving overlapping status and freshness reasons. */
export function summarizeConnectionMetrics(
  connections: ConnectionCoverage[],
): OperationalMetricRead<ConnectionMetricItem>[] {
  const population = connections.filter((c) => c.status !== 'disconnected');
  const items = population
    .filter((c) => c.status !== 'active' || c.freshness !== 'fresh')
    .map((c) => ({
      ...c,
      kind: 'connection' as const,
      reasons: [
        ...(c.status !== 'active' ? [c.status] : []),
        ...(c.freshness !== 'fresh' ? [c.freshness] : []),
      ],
    }));
  const boundaries = population
    .flatMap((c) => (c.nextRefreshAt ? [c.nextRefreshAt] : []))
    .sort();
  const observed = population
    .flatMap((c) => (c.lastObservedAt ? [c.lastObservedAt] : []))
    .sort();

  return [
    {
      definition: connectionMetricDefinitions[0]!,
      value: items.length,
      total: items.length,
      observedCount: items.length,
      unknownCount: 0,
      population: population.length,
      coverage: 'complete',
      coverageExplanation:
        'Installed workspace connections and their permitted reads. This does not measure provider record completeness.',
      freshness: !observed.length
        ? 'unobserved'
        : items.length
          ? 'stale'
          : 'fresh',
      observedAt: observed.at(-1) ?? null,
      dataThrough: null,
      nextRefreshAt: boundaries[0] ?? null,
      breakdown: [],
      items,
    },
  ];
}
