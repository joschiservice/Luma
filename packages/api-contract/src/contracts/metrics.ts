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
      422: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: 'Read selected operational metrics and matching records',
    description:
      'Reads cases, monitored stock, purchase orders, connection health and evidence-backed resolution outcomes in one consistent, current read. Select metric IDs explicitly. Filters must be supported by every selected metric. Each metric returns its first page of records; pass a metric’s nextCursor as cursor to read the records after that page. Pages read current data, so records can join or leave between pages; deduplicate by ID. A cursor from another request returns 422. Resolution alone accepts environment and a 24-hour or seven-day first-detection window; other families describe current state. Null values, unknown classification and unavailable coverage are distinct from zero.',
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
      'Reads up to four parts, each an order (v1) or operational (v2) metric query, with the same rules as those endpoints, and returns them in request order. A part that fails carries its own status and error; the other parts are unaffected. Each part returns its first page of records; read later pages through the part’s own query endpoint. nextRefreshAt is the earliest boundary across the parts that were read.',
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
      400: apiErrorSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
      422: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: 'Read order totals and their matching records',
    description:
      'Returns open, overdue and attention counts with a page of matching orders for each, from one consistent, current read. Null totals mean incomplete source coverage; observedCount counts only known matching orders. Pass a metric’s nextCursor as cursor to read the orders after that page; pages read current data, so deduplicate by ID. A cursor from another request returns 422. Windows filter accepted source update times using [updatedFrom, updatedBefore) UTC instants. Requests accept only registered fields, never executable code.',
  },
});
