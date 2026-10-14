import { z } from 'zod';

import { activityPageSchema, activityQuerySchema } from '../activity.js';
import { endpoint, organizationParamsSchema, requires } from '../common.js';

export const activityContract = {
  list: endpoint
    .route({
      method: 'GET',
      path: '/v1/organizations/{organizationId}/activity',
      summary: 'Search workspace activity',
      description:
        'Returns recorded events newest first by recorded timestamp and immutable ID. Date bounds apply to recorded time, including from and excluding to, for at most 366 days. Search matches issue ID, persisted target reference, action label, actor ID and workflow run ID (literal, case-insensitive substring). Raw payloads are not searched. `actor` keeps events recorded by any of the named actors; it only narrows what the caller may already see. Cursors are bound to workspace, restricted-activity access, filters and page size; any other cursor returns 400 with a message to start from the first page. Connection changes and access changes (members, invitations, roles and workspace settings, type `access`) are visible only with the View restricted activity permission; `visibility` is `admin` for those callers. Approval and provider acceptance do not establish verified resolution.',
    })
    .meta({
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
};
