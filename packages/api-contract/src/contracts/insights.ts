import { initContract } from '@ts-rest/core';

import { apiErrorSchema, organizationParamsSchema } from '../common.js';
import {
  insightChartResponseSchema,
  insightChartSchema,
  insightQuerySchema,
  insightRecordListSchema,
  insightRecordQuerySchema,
} from '../insights.js';

const c = initContract();

const params = organizationParamsSchema.extend({ chart: insightChartSchema });

const errors = {
  400: apiErrorSchema,
  401: apiErrorSchema,
  403: apiErrorSchema,
  404: apiErrorSchema,
  503: apiErrorSchema,
};

export const insightsContract = c.router({
  chart: {
    method: 'GET',
    path: '/v1/organizations/:organizationId/insights/:chart',
    pathParams: params,
    query: insightQuerySchema,
    responses: { 200: insightChartResponseSchema, ...errors },
    summary: 'Read an operational chart',
    description:
      'Counts records for one chart. Timelines place each record in a calendar day or week of `timeZone` by a time its source or Luma recorded: `orders` by the source’s placed time, colored by current status; `cases` by first detection, by issue class. Breakdowns classify current state at `asOf`: `fulfillment` open work by time since its last reported progress, under its first signal (held, past fulfill-by, no progress); `stock` monitored positions against their replenishment minimum; `procurement` purchase orders by stage, overdue or not. Linked orders count once; with `connectionId`, each source’s own records count. Fulfillment work reported by two systems counts once per system. Past states are never reconstructed: a breakdown is today’s state, not history. `coverage` lists each source’s import state; points before imported history are `not_imported`, which means unknown, not zero. `dataThrough` is the oldest complete read across the sources.',
  },
  records: {
    method: 'GET',
    path: '/v1/organizations/:organizationId/insights/:chart/records',
    pathParams: params,
    query: insightRecordQuerySchema,
    responses: { 200: insightRecordListSchema, ...errors },
    summary: 'List the records behind a chart point',
    description:
      'Lists the records counted in one chart point and series, using the same rules, filters and evaluation time as the chart. Pass the chart’s `asOf` so time-based rules match; `totalCount` then equals the chart value unless records changed since. Results contain up to `limit` records (at most 100) from `offset`; `nextOffset` continues the list.',
  },
});
