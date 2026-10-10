import { z } from 'zod';

import { endpoint, organizationParamsSchema, requires } from '../common.js';
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

export const metricsContract = {
  operationalDefinitions: endpoint
    .route({
      method: 'GET',
      path: '/v2/organizations/{organizationId}/metrics',
      summary: 'Read the operational metric registry',
      description:
        'Lists domain-owned definitions. Order definitions use v1 query semantics; other families use v2 with coverage and typed cohorts per metric.',
    })
    .meta({ access: requires('insights.read'), errors: [401, 404] })
    .input(z.object({ params: organizationParamsSchema }))
    .output(
      z.array(
        z.union([metricDefinitionSchema, operationalMetricDefinitionSchema]),
      ),
    ),
  operationalQuery: endpoint
    .route({
      method: 'POST',
      path: '/v2/organizations/{organizationId}/metrics/query',
      summary: 'Read selected operational metrics and matching records',
      description:
        'Reads cases, monitored stock, purchase orders, connection health and evidence-backed resolution outcomes in one consistent, current read. Select metric IDs explicitly. Filters must be supported by every selected metric. Each metric returns its first page of records; pass a metric’s nextCursor as cursor to read the records after that page. Pages read current data, so records can join or leave between pages; deduplicate by ID. A cursor from another request returns 422. Resolution alone accepts environment and a 24-hour or seven-day first-detection window; other families describe current state. Null values, unknown classification and unavailable coverage are distinct from zero.',
    })
    .meta({
      access: requires('insights.read'),
      errors: [400, 401, 404, 422, 503],
      readOnly: true,
    })
    .input(
      z.object({
        params: organizationParamsSchema,
        body: operationalMetricRequestSchema,
      }),
    )
    .output(operationalMetricResponseSchema),
  summary: endpoint
    .route({
      method: 'POST',
      path: '/v2/organizations/{organizationId}/metrics/summary',
      summary: 'Read several metric views in one request',
      description:
        'Reads up to four parts, each an order (v1) or operational (v2) metric query, with the same rules as those endpoints, and returns them in request order. A part that fails carries its own status and error; the other parts are unaffected. Each part returns its first page of records; read later pages through the part’s own query endpoint. nextRefreshAt is the earliest boundary across the parts that were read.',
    })
    .meta({
      access: requires('insights.read'),
      errors: [400, 401, 404],
      readOnly: true,
    })
    .input(
      z.object({
        params: organizationParamsSchema,
        body: metricSummaryRequestSchema,
      }),
    )
    .output(metricSummaryResponseSchema),
  definitions: endpoint
    .route({
      method: 'GET',
      path: '/v1/organizations/{organizationId}/metrics',
      summary: 'Read shared operational metric definitions',
      description:
        'Lists versioned counting rules, supported filters, permissions and drill-down semantics for canonical order metrics.',
    })
    .meta({ access: requires('insights.read'), errors: [401, 404, 503] })
    .input(z.object({ params: organizationParamsSchema }))
    .output(z.array(metricDefinitionSchema)),
  query: endpoint
    .route({
      method: 'POST',
      path: '/v1/organizations/{organizationId}/metrics/query',
      summary: 'Read order totals and their matching records',
      description:
        'Returns open, overdue and attention counts with a page of matching orders for each, from one consistent, current read. Null totals mean incomplete source coverage; observedCount counts only known matching orders. Pass a metric’s nextCursor as cursor to read the orders after that page; pages read current data, so deduplicate by ID. A cursor from another request returns 422. Windows filter accepted source update times using [updatedFrom, updatedBefore) UTC instants. Requests accept only registered fields, never executable code.',
    })
    .meta({
      access: requires('insights.read'),
      errors: [400, 401, 404, 422, 503],
      readOnly: true,
    })
    .input(
      z.object({ params: organizationParamsSchema, body: metricRequestSchema }),
    )
    .output(metricResponseSchema),
};
