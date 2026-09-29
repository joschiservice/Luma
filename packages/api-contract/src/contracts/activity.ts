import { initContract } from '@ts-rest/core';

import { activityPageSchema, activityQuerySchema } from '../activity.js';
import { apiErrorSchema, organizationParamsSchema } from '../common.js';

export const activityContract = initContract().router({
  list: {
    method: 'GET',
    path: '/v1/organizations/:organizationId/activity',
    pathParams: organizationParamsSchema,
    query: activityQuerySchema,
    responses: {
      200: activityPageSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: 'Search workspace activity',
    description:
      'Returns recorded events newest first by recorded timestamp and immutable ID. Date bounds apply to recorded time, including from and excluding to, for at most 366 days. Search matches issue ID, persisted target reference, action label, actor ID and workflow run ID (literal, case-insensitive substring). Raw payloads are not searched. Cursors are bound to workspace, role, filters and page size; any other cursor returns 400 with a message to start from the first page. Connection administration events are visible only to owners and administrators. Approval and provider acceptance do not establish verified resolution.',
  },
});
