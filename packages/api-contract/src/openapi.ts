import { OpenAPIGenerator } from '@orpc/openapi';
import { ZodToJsonSchemaConverter } from '@orpc/zod/zod4';

import { apiErrorSchema } from './common.js';
import type { EventStreamRoute } from './contracts/events.js';
import {
  apiContract,
  caseEventsContract,
  contractRoutes,
  metricEventsContract,
} from './index.js';

type Operation = {
  tags?: string[];
  parameters?: unknown[];
  responses?: Record<string, unknown>;
  security?: Record<string, string[]>[];
  'x-luma-public-api'?: true;
  'x-luma-personal-data'?: true;
};

// Body parsing and unexpected failures can reject any route.
const globalErrors = [400, 413, 415, 500] as const;
const errorResponse = (status: number) => ({
  description: String(status),
  content: {
    'application/json': { schema: { $ref: '#/components/schemas/ApiError' } },
  },
});
const converter = new ZodToJsonSchemaConverter();

/** OpenAPI 3.1 description of the customer API, served at `/openapi.json`. */
export const openApiDocument = await new OpenAPIGenerator({
  schemaConverters: [converter],
}).generate(apiContract, {
  info: {
    title: 'Luma API',
    version: '1.0.0',
    description:
      'Read cases, evidence, proposals, execution and audit history. Make permitted decisions and follow authenticated progress streams. Manage organizations, memberships and installed connections. Organization endpoints require a session cookie; operations marked `x-luma-public-api` also accept a personal API app token.',
  },
  commonSchemas: { ApiError: { schema: apiErrorSchema } },
});
(openApiDocument.components ??= {}).securitySchemes = {
  apiToken: {
    type: 'http',
    scheme: 'bearer',
    description:
      'A personal API app token, created in workspace settings. It acts for the person who created it, limited to the permissions they chose, in one workspace.',
  },
};
const paths = (openApiDocument.paths ??= {}) as Record<
  string,
  Record<string, Operation>
>;

for (const route of contractRoutes(apiContract)) {
  const operation = paths[route.path]![route.method.toLowerCase()]!;
  operation.tags = [route.key.split('.')[0]!];
  // Tokens can be refused, lack a permission or exceed the rate limit on any public route.
  const tokenErrors = route.meta.publicApi ? [401, 403, 429] : [];
  for (const status of [
    ...(route.meta.errors ?? []),
    ...tokenErrors,
    ...globalErrors,
  ])
    (operation.responses ??= {})[status] ??= errorResponse(status);
  if (route.meta.publicApi) {
    operation['x-luma-public-api'] = true;
    operation.security = [{ apiToken: [] }];
  }
  if (route.meta.personalData) operation['x-luma-personal-data'] = true;
}

for (const [area, stream] of [
  ['caseEvents', caseEventsContract.events],
  ['metricEvents', metricEventsContract.events],
] as const)
  paths[stream.path.replace(/:(\w+)/g, '{$1}')] = {
    get: await streamOperation(area, stream),
  };

/**
 * OpenAPI 3.1 description of the public API, served at `/openapi.public.json`: only operations
 * personal API apps may call, each authenticated with a bearer token.
 */
export const publicOpenApiDocument: typeof openApiDocument =
  structuredClone(openApiDocument);
publicOpenApiDocument.info = {
  title: 'Luma public API',
  version: '1.0.0',
  description:
    'Read your workspace’s orders, fulfillment, stock, products, customers, returns, issues, workflows and activity with a personal API app token. Send it as `Authorization: Bearer <token>`. A token works in one workspace, with the permissions it was granted that its creator still holds. Requests are limited per token and per workspace: responses report the tighter limit in `RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset`, and a 429 response says when to retry in `Retry-After`. Reads of operations marked `x-luma-personal-data` by a token that can read customers are counted and recorded in the workspace’s activity. `/changes` reports which records changed, so a copy stays current without reading everything again.',
};
publicOpenApiDocument.security = [{ apiToken: [] }];
const publicPaths = (publicOpenApiDocument.paths ??= {}) as Record<
  string,
  Record<string, Operation>
>;
for (const [path, operations] of Object.entries(publicPaths)) {
  for (const [method, operation] of Object.entries(operations))
    if (!operation['x-luma-public-api']) delete operations[method];
  if (!Object.keys(operations).length) delete publicPaths[path];
}

/** Documents a server-sent event stream that is served outside the contract router. */
async function streamOperation(area: string, stream: EventStreamRoute) {
  const parameters = await Promise.all(
    Object.entries(stream.pathParams.shape).map(async ([name, schema]) => ({
      name,
      in: 'path',
      required: true,
      schema: (await converter.convert(schema, { strategy: 'input' }))[1],
    })),
  );

  return {
    operationId: `${area}.events`,
    summary: stream.summary,
    description: stream.description,
    tags: [area],
    parameters: [
      ...parameters,
      {
        in: 'header',
        name: 'Last-Event-ID',
        required: false,
        schema: { type: 'string' },
        description: 'Reconnects with a fresh authoritative snapshot.',
      },
    ],
    responses: {
      200: {
        description:
          'SSE resync events. Refetch the subscribed resource when refetch is true.',
        content: { 'text/event-stream': { schema: { type: 'string' } } },
      },
      ...Object.fromEntries(
        [...stream.errors, 500].map((status) => [
          status,
          errorResponse(status),
        ]),
      ),
    },
  };
}
