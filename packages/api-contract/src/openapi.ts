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
      'Read cases, evidence, proposals, execution and audit history. Make permitted decisions and follow authenticated progress streams. Manage organizations, memberships and installed connections. Organization endpoints require a session cookie.',
  },
  commonSchemas: { ApiError: { schema: apiErrorSchema } },
});
const paths = (openApiDocument.paths ??= {}) as Record<
  string,
  Record<string, Operation>
>;

for (const route of contractRoutes(apiContract)) {
  const operation = paths[route.path]![route.method.toLowerCase()]!;
  operation.tags = [route.key.split('.')[0]!];
  for (const status of [...(route.meta.errors ?? []), ...globalErrors])
    (operation.responses ??= {})[status] ??= errorResponse(status);
}

for (const [area, stream] of [
  ['caseEvents', caseEventsContract.events],
  ['metricEvents', metricEventsContract.events],
] as const)
  paths[stream.path.replace(/:(\w+)/g, '{$1}')] = {
    get: await streamOperation(area, stream),
  };

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
