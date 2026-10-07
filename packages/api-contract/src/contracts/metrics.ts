import { initContract } from '@ts-rest/core';
import { z } from 'zod';

import {
  apiErrorSchema,
  organizationParamsSchema,
  requires,
} from '../common.js';
import {
  metricSummaryRequestSchema,
  metricSummaryResponseSchema,
} from '../metric-summary.js';
import {
  metricDefinitionSchema,
  metricRequestSchema,
  metricResponseSchema,
} from '../metrics.js';
import {
  operationalMetricDefinitionSchema,
  operationalMetricRequestSchema,
  operationalMetricResponseSchema,
} from '../operational-metrics.js';

const c = initContract();

export const metricsContract = c.router({
  operationalDefinitions: {
    method: 'GET',
    metadata: requires('insights.read'),
    path: '/v2/organizations/:organizationId/metrics',
    pathParams: organizationParamsSchema,
    responses: {
      200: z.array(
        z.union([metricDefinitionSchema, operationalMetricDefinitionSchema]),
      ),
      401: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: 'Read the operational metric registry',
    description:
      'Lists domain-owned definitions. Order definitions use v1 query semantics; other families use v2 with coverage and typed cohorts per metric.',
  },
  operationalQuery: {
    method: 'POST',
    metadata: requires('insights.read'),
    path: '/v2/organizations/:organizationId/metrics/query',
    pathParams: organizationParamsSchema,
    body: operationalMetricRequestSchema,
    responses: {
      200: operationalMetricResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: 'Read selected operational metrics and matching records',
    description:
      'Reads cases, monitored stock, purchase orders, connection health and evidence-backed resolution outcomes in one authorized snapshot. Select metric IDs explicitly. Filters must be supported by every selected metric. Reuse snapshot and asOf for pagination; refresh on 409. Resolution alone accepts environment and a 24-hour or seven-day first-detection window; other families describe current state. Null values, unknown classification and unavailable coverage are distinct from zero.',
  },
  summary: {
    method: 'POST',
    metadata: requires('insights.read'),
    path: '/v2/organizations/:organizationId/metrics/summary',
    pathParams: organizationParamsSchema,
    body: metricSummaryRequestSchema,
    responses: {
      200: metricSummaryResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: 'Read several metric views in one request',
    description:
      'Reads up to four parts, each an order (v1) or operational (v2) metric query, with the same rules as those endpoints, and returns them in request order. A part that fails carries its own status and error; the other parts are unaffected. Each part has its own snapshot and asOf; page a part through its own query endpoint. nextRefreshAt is the earliest boundary across the parts that were read.',
  },
  definitions: {
    method: 'GET',
    metadata: requires('insights.read'),
    path: '/v1/organizations/:organizationId/metrics',
    pathParams: organizationParamsSchema,
    responses: {
      200: z.array(metricDefinitionSchema),
      401: apiErrorSchema,
      404: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: 'Read shared operational metric definitions',
    description:
      'Lists versioned counting rules, supported filters, permissions and drill-down semantics for canonical order metrics.',
  },
  query: {
    method: 'POST',
    metadata: requires('insights.read'),
    path: '/v1/organizations/:organizationId/metrics/query',
    pathParams: organizationParamsSchema,
    body: metricRequestSchema,
    responses: {
      200: metricResponseSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: 'Read order totals and their matching records',
    description:
      'Returns open, overdue and attention counts with bounded cohorts from one consistent read snapshot. Null totals mean incomplete source coverage; observedCount counts only known matching orders. Reuse snapshot and asOf when paging. A 409 requires refreshing from offset zero. Windows filter accepted source update times using [updatedFrom, updatedBefore) UTC instants. Requests accept only registered fields, never executable code.',
  },
});
