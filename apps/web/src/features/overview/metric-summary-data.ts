import {
  type MetricRequest,
  type MetricSummaryRequest,
  type OperationalMetricRequest,
  type WorkspaceTopic,
} from '@luma/api-contract';
import { queryOptions } from '@tanstack/react-query';

import { createWebApiClient } from '../../lib/api-client';
import { privateQueryDefaults } from '../../lib/private-query';

const api = createWebApiClient();

/** One view a page reads through its shared metric summary. */
export type SummaryPart =
  | { kind: 'orders'; request: MetricRequest }
  | { kind: 'operational'; request: OperationalMetricRequest };

/** Caches every metric summary of a workspace under one prefix. */
export const metricSummaryKey = (organizationId: string) =>
  ['private', 'organization', organizationId, 'metric-summary'] as const;

/** Reads every part of a page's metrics in one request; each part succeeds or fails on its own. */
export function metricSummaryOptions(
  organizationId: string,
  parts: MetricSummaryRequest['parts'],
) {
  return queryOptions({
    queryKey: [...metricSummaryKey(organizationId), parts],
    ...privateQueryDefaults,
    retry: false,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    queryFn: ({ signal }) =>
      api.metrics.summary(
        { params: { organizationId }, body: { parts } },
        { signal },
      ),
  });
}

const familyTopics: Record<string, readonly WorkspaceTopic[]> = {
  cases: ['issues'],
  inventory: ['inventory', 'procurement'],
  procurement: ['procurement'],
  connections: ['connections'],
  resolution: ['issues', 'resolution', 'connections'],
};

/** Lists the workspace areas whose changes can alter a part. */
export function partTopics(part: SummaryPart): readonly WorkspaceTopic[] {
  if (part.kind === 'orders') return ['orders', 'issues', 'connections'];

  return part.request.metrics.flatMap(
    (id) => familyTopics[id.split('.')[0]!] ?? [],
  );
}
