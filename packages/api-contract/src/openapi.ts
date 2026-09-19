import { generateOpenApi } from '@ts-rest/open-api';
import { apiContract, caseEventsContract } from './index.js';

export const openApiDocument = generateOpenApi(
  { ...apiContract, caseEvents: caseEventsContract },
  {
    info: {
      title: 'Luma API',
      version: '1.0.0',
      description:
        'Read cases, evidence, proposals, execution and audit history. Make permitted decisions and follow authenticated progress streams. Manage organizations, memberships and installed connections. Organization endpoints require a session cookie.',
    },
  },
  {
    setOperationId: 'concatenated-path',
    operationMapper: (operation, route) =>
      route.path === caseEventsContract.events.path
        ? {
            ...operation,
            parameters: [
              ...(operation.parameters ?? []),
              {
                in: 'header',
                name: 'Last-Event-ID',
                required: false,
                schema: { type: 'string' },
                description: 'Reconnects with a fresh authoritative snapshot.',
              },
            ],
            // ts-rest 3.52 does not emit content for otherResponse schemas.
            responses: {
              ...operation.responses,
              200: {
                description:
                  'SSE resync events carrying a CaseProgress snapshot and refetch: true.',
                content: {
                  'text/event-stream': { schema: { type: 'string' } },
                },
              },
            },
          }
        : operation,
  },
);
