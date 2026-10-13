import { z } from 'zod';

import { anyMember, endpoint, organizationParamsSchema } from '../common.js';

export const adaptiveContract = {
  availability: endpoint
    .route({
      method: 'GET',
      path: '/v1/organizations/{organizationId}/adaptive/availability',
      summary: 'Read adaptive workspace feature availability',
    })
    .meta({ access: anyMember, errors: [401, 403, 503] })
    .input(z.object({ params: organizationParamsSchema }))
    .output(
      z.object({
        fields: z.boolean(),
        views: z.boolean(),
        generation: z.boolean(),
        actions: z.boolean(),
        packages: z.boolean(),
      }),
    ),
};
