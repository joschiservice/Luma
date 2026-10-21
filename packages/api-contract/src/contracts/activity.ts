import { z } from 'zod';

import {
  activityCountsQuerySchema,
  activityCountsSchema,
  activityExportRequestSchema,
  activityExportSchema,
  activityPageSchema,
  activityQuerySchema,
} from '../activity.js';
import { endpoint, organizationParamsSchema, requires } from '../common.js';

export const activityContract = {
  list: endpoint
    .route({
      method: 'GET',
      path: '/v1/organizations/{organizationId}/activity',
      summary: 'Search workspace activity',
      description:
        'The `business` view groups events by issue, run or proposal and hides routine checks; `detail=steps` includes up to 100 earlier steps under the same visibility and filters. The default event view retains each immutable record. Returns recorded events newest first by recorded timestamp and immutable ID. Date bounds apply to recorded time, including from and excluding to, for at most 366 days. Search matches issue ID, issue class, persisted target reference, action label, actor ID and workflow run ID (literal, case-insensitive substring), and events of the issue classes named in `searchIssueClasses`. Raw payloads are not searched. `actor` keeps events recorded by any of the named actors and `outcome` keeps events with any of the named outcomes; both only narrow what the caller may already see. Cursors are bound to workspace, restricted-activity access, filters and page size; any other cursor returns 400 with a message to start from the first page. Connection changes and access changes (members, invitations, roles and workspace settings, type `access`) are visible only with the View restricted activity permission; `visibility` is `admin` for those callers. Approval and provider acceptance do not establish verified resolution.',
    })
    .meta({
      publicApi: true,
      access: requires('activity.read'),
      errors: [400, 401, 403, 404, 503],
    })
    .input(
      z.object({
        params: organizationParamsSchema,
        query: activityQuerySchema,
      }),
    )
    .output(activityPageSchema),
  counts: endpoint
    .route({
      method: 'GET',
      path: '/v1/organizations/{organizationId}/activity/counts',
      summary: 'Count workspace activity by outcome',
      description:
        'Counts the groups of the `business` view that match the filters: in total, with a failed, unclear or escalated event (`attention`), and per outcome. A group counts under each outcome one of its non-routine events has, so each count equals the number of groups the list shows with that outcome filter. Reads with the same visibility as the list.',
    })
    .meta({
      access: requires('activity.read'),
      errors: [400, 401, 403, 404, 503],
    })
    .input(
      z.object({
        params: organizationParamsSchema,
        query: activityCountsQuerySchema,
      }),
    )
    .output(activityCountsSchema),
  export: endpoint
    .route({
      method: 'POST',
      path: '/v1/organizations/{organizationId}/activity/export',
      summary: 'Export workspace activity as CSV',
      description:
        'Exports every recorded event that matches the filters, one row each and newest first, with the visibility of the list. Needs permission to export lists and to view activity; read-only support views cannot export. At most 5,000 rows are exported; `truncated` says when more match, and the file then ends with the `truncated` line. Headings and readable names for recorded codes come from the request; codes without a name are written as recorded. Every export is recorded in the audit log without its values.',
    })
    .meta({
      access: requires('lists.export'),
      errors: [400, 401, 403, 404, 503],
    })
    .input(
      z.object({
        params: organizationParamsSchema,
        body: activityExportRequestSchema,
      }),
    )
    .output(activityExportSchema),
};
