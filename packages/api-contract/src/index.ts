import {
  startResolutionRunSchema,
  learningCommandSchema,
  resolutionRunSchema,
  learningEventSchema,
  resolutionHistorySchema,
} from './learning.js';
export * from './learning.js';
import {
  caseDecisionSchema,
  decisionReceiptSchema,
  caseReviewSchema,
  caseProgressSchema,
  caseTimelineSchema,
} from './desk.js';
export * from './desk.js';
import { overviewQuerySchema, operationsOverviewSchema } from './overview.js';
export * from './overview.js';
import {
  caseQuerySchema,
  caseListSchema,
  caseDetailSchema,
  caseEvidenceQuerySchema,
  caseEvidencePageSchema,
} from './cases.js';
export * from './cases.js';
import {
  installedConnectionSchema,
  installationInput,
  installationCredentials,
} from './connections.js';
export * from './connections.js';
import { initContract } from '@ts-rest/core';
import { z } from 'zod';

const c = initContract();

export const dataRegionSchema = z.enum(['EU', 'US', 'APAC']);
export const organizationParamsSchema = z.object({
  organizationId: z.string().uuid(),
});
export const apiErrorSchema = z.object({
  code: z.enum([
    'VALIDATION_ERROR',
    'UNAUTHENTICATED',
    'FORBIDDEN',
    'NOT_FOUND',
    'CONFLICT',
    'REGION_UNAVAILABLE',
    'SERVICE_UNAVAILABLE',
    'NOT_READY',
    'INTERNAL_ERROR',
    'PAYLOAD_TOO_LARGE',
    'TOO_MANY_REQUESTS',
    'UNSUPPORTED_MEDIA_TYPE',
  ]),
  message: z.string(),
  requestId: z.string(),
});
export type ApiError = z.infer<typeof apiErrorSchema>;

export const connectorProviderSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  name: z.string().min(1),
  category: z.enum(['storefront', 'erp']),
});
export type ConnectorProvider = z.infer<typeof connectorProviderSchema>;

export const roleSchema = z.enum(['owner', 'admin', 'member']);
export const organizationSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  slug: z.string(),
  dataRegion: dataRegionSchema,
  status: z.enum(['active', 'suspended', 'closed']),
});
export const membershipSchema = z.object({
  id: z.string().uuid(),
  organizationId: z.string().uuid(),
  userId: z.string().uuid(),
  role: roleSchema,
});
export const tenantContextSchema = z.object({
  tenantId: z.string().uuid(),
  dataRegion: z.literal('EU'),
  requestId: z.string(),
  actor: z.object({
    type: z.literal('user'),
    id: z.string().uuid(),
    initiatingUserId: z.string().uuid(),
    sessionId: z.string().uuid(),
    membershipId: z.string().uuid(),
    role: roleSchema,
  }),
});
const memberParamsSchema = organizationParamsSchema.extend({
  memberId: z.string().uuid(),
});
const identityContract = c.router(
  {
    listOrganizations: {
      method: 'GET',
      path: '/v1/organizations',
      responses: { 200: z.object({ items: z.array(organizationSchema) }) },
      summary: 'List your organizations',
    },
    createOrganization: {
      method: 'POST',
      path: '/v1/organizations',
      body: z
        .object({
          name: z.string().trim().min(1).max(200),
          slug: z
            .string()
            .min(1)
            .max(100)
            .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
          dataRegion: dataRegionSchema.optional(),
        })
        .strict(),
      responses: { 201: organizationSchema, 422: apiErrorSchema },
      summary: 'Create an organization',
      description:
        'Creates an EU organization with you as its owner. Other regions are unavailable.',
    },
    context: {
      method: 'GET',
      path: '/v1/organizations/:organizationId/context',
      pathParams: organizationParamsSchema,
      responses: { 200: tenantContextSchema },
      summary: 'Resolve your organization access',
    },
    listMembers: {
      method: 'GET',
      path: '/v1/organizations/:organizationId/members',
      pathParams: organizationParamsSchema,
      responses: { 200: z.object({ items: z.array(membershipSchema) }) },
      summary: 'List organization members',
    },
    addMember: {
      method: 'POST',
      path: '/v1/organizations/:organizationId/members',
      pathParams: organizationParamsSchema,
      body: z.object({ userId: z.string().uuid(), role: roleSchema }).strict(),
      responses: { 201: membershipSchema },
      summary: 'Add a registered user to an organization',
      description:
        'Owners and admins can add users. Only owners can grant ownership.',
    },
    updateMember: {
      method: 'PATCH',
      path: '/v1/organizations/:organizationId/members/:memberId',
      pathParams: memberParamsSchema,
      body: z.object({ role: roleSchema }).strict(),
      responses: { 200: membershipSchema },
      summary: 'Change a member role',
    },
    removeMember: {
      method: 'DELETE',
      path: '/v1/organizations/:organizationId/members/:memberId',
      pathParams: memberParamsSchema,
      body: c.noBody(),
      responses: { 204: c.noBody() },
      summary: 'Remove an organization member',
      description: 'The last owner cannot be removed or demoted.',
    },
  },
  {
    commonResponses: {
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
      503: apiErrorSchema,
    },
  },
);

const connectionParams = organizationParamsSchema.extend({
  connectionId: z.string().uuid(),
});
const connectionVersion = z
  .object({ version: z.number().int().positive() })
  .strict();
const connectionsContract = c.router(
  {
    shopifyStart: {
      method: 'POST',
      path: '/v1/organizations/:organizationId/connections/shopify/authorize',
      pathParams: organizationParamsSchema,
      body: z
        .object({
          shop: z
            .string()
            .max(253)
            .regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.myshopify\.com$/),
          label: z.string().trim().min(1).max(120),
        })
        .strict(),
      responses: { 200: z.object({ authorizationUrl: z.string().url() }) },
      summary: 'Connect or reconnect Shopify',
      description:
        'Owners and admins receive a Shopify authorization URL. Approve access in Shopify to connect the store to this workspace.',
    },
    list: {
      method: 'GET',
      path: '/v1/organizations/:organizationId/connections',
      pathParams: organizationParamsSchema,
      responses: {
        200: z.object({ items: z.array(installedConnectionSchema) }),
      },
      summary: 'List installed organization connections',
    },
    install: {
      method: 'POST',
      path: '/v1/organizations/:organizationId/connections',
      pathParams: organizationParamsSchema,
      body: installationInput,
      responses: { 201: installedConnectionSchema },
      summary: 'Install a connection',
      description:
        'Owners and admins can submit credentials. The connection remains pending until a successful permission check.',
    },
    check: {
      method: 'POST',
      path: '/v1/organizations/:organizationId/connections/:connectionId/check',
      pathParams: connectionParams,
      body: connectionVersion,
      responses: { 200: installedConnectionSchema },
      summary: 'Validate credentials and requested permissions',
    },
    rotate: {
      method: 'POST',
      path: '/v1/organizations/:organizationId/connections/:connectionId/credentials',
      pathParams: connectionParams,
      body: connectionVersion.extend({ credentials: installationCredentials }),
      responses: { 200: installedConnectionSchema },
      summary: 'Replace connection credentials',
      description:
        'Replaces credentials and clears verified permissions. Check the connection again to restore access. Use the latest connection version.',
    },
    disconnect: {
      method: 'POST',
      path: '/v1/organizations/:organizationId/connections/:connectionId/disconnect',
      pathParams: connectionParams,
      body: connectionVersion,
      responses: { 200: installedConnectionSchema },
      summary: 'Disconnect an installed connection',
      description:
        'Deletes stored credentials and stops further use. Does not revoke provider tokens or cancel requests already sent. Install a new connection to reconnect.',
    },
  },
  {
    commonResponses: {
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
      422: apiErrorSchema,
      503: apiErrorSchema,
    },
  },
);

const caseParams = organizationParamsSchema.extend({
  exceptionId: z.string().uuid(),
});
export const caseEventsContract = c.router({
  events: {
    method: 'GET',
    path: '/v1/organizations/:organizationId/exceptions/:exceptionId/events',
    pathParams: caseParams,
    responses: {
      200: c.otherResponse({
        contentType: 'text/event-stream',
        body: z.string(),
      }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      429: apiErrorSchema,
      500: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: 'Follow case progress',
    description:
      'Authenticated SSE emits resync events with a current progress snapshot every five seconds. Refetch case, review and timeline on each event and reconnect. Last-Event-ID always resynchronizes current state; events are not an audit replay. Sessions and membership are checked before each snapshot. Streams reconnect after one minute. Slow consumers are disconnected. Use the timeline endpoint for persisted history.',
  },
});
export const apiContract = c.router(
  {
    resolutionLearning: c.router(
      {
        list: {
          method: 'GET',
          path: '/v1/organizations/:organizationId/exceptions/:exceptionId/resolution-runs',
          pathParams: caseParams,
          query: z.object({ after: z.string().uuid().optional() }),
          responses: {
            200: z.object({
              items: z.array(resolutionRunSchema),
              nextCursor: z.string().uuid().nullable(),
            }),
          },
          summary: 'List resolution runs',
          description:
            'Owners and admins can find up to 50 runs for a case. Pass nextCursor as after to continue; IDs provide stable page ordering. Refresh from the first page to discover newly recorded runs.',
        },
        start: {
          method: 'POST',
          path: '/v1/organizations/:organizationId/exceptions/:exceptionId/resolution-runs',
          pathParams: caseParams,
          body: startResolutionRunSchema,
          responses: { 200: resolutionRunSchema },
          summary: 'Record a resolution selection',
          description:
            'Owners and admins record a run ID, diagnosis revision, resolution version and reason. Reuse the run ID for automated steps. Exact retries return the original record; conflicting IDs return 409.',
        },
        append: {
          method: 'POST',
          path: '/v1/organizations/:organizationId/exceptions/:exceptionId/resolution-runs/:runId/events',
          pathParams: caseParams.extend({ runId: z.string().uuid() }),
          body: learningCommandSchema,
          responses: { 200: learningEventSchema },
          summary: 'Record a resolution observation',
          description:
            'Append cause assessments, repairs, interventions, edits, outcomes or recurrence links. Use codes and incident evidence references. Model hypotheses remain suspected. Verified outcomes require the incident’s authoritative verification. Exact retries return the original event.',
        },
        read: {
          method: 'GET',
          path: '/v1/organizations/:organizationId/exceptions/:exceptionId/resolution-runs/:runId',
          pathParams: caseParams.extend({ runId: z.string().uuid() }),
          responses: { 200: resolutionHistorySchema },
          summary: 'Read resolution learning history',
          description:
            'Owners and admins can export the original context, ordered operator records, bound steps, execution and all verification attempts. A pending attempt without completion has no known result. Execution acceptance does not establish business success.',
        },
      },
      {
        commonResponses: {
          401: apiErrorSchema,
          403: apiErrorSchema,
          404: apiErrorSchema,
          409: apiErrorSchema,
          503: apiErrorSchema,
        },
      },
    ),
    caseDesk: c.router(
      {
        review: {
          method: 'GET',
          path: '/v1/organizations/:organizationId/exceptions/:exceptionId/review',
          pathParams: caseParams,
          responses: { 200: caseReviewSchema },
          summary: 'Review a case proposal',
          description:
            'Returns an immutable proposal, its current policy result and permitted decisions. Unavailable capabilities cannot be approved. Manual recommendations remain in the case investigation.',
        },
        decide: {
          method: 'POST',
          path: '/v1/organizations/:organizationId/exceptions/:exceptionId/decisions',
          pathParams: caseParams,
          body: caseDecisionSchema,
          responses: { 200: decisionReceiptSchema },
          summary: 'Approve, reject or escalate a case',
          description:
            'Use a unique commandId and the current case, diagnosis, proposal and policy versions from review. Exact retries return the committed receipt. Conflicts return 409. Approval records a decision; it does not mean execution or verification succeeded.',
        },
        receipt: {
          method: 'GET',
          path: '/v1/organizations/:organizationId/exceptions/:exceptionId/decisions/:commandId',
          pathParams: caseParams.extend({ commandId: z.string().uuid() }),
          responses: { 200: decisionReceiptSchema },
          summary: 'Recover a decision result',
          description:
            'After a timeout, read the receipt using the original command ID or retry the identical request. Receipts are visible to their submitting actor.',
        },
        progress: {
          method: 'GET',
          path: '/v1/organizations/:organizationId/exceptions/:exceptionId/progress',
          pathParams: caseParams,
          responses: { 200: caseProgressSchema },
          summary: 'Read execution and verification progress',
          description:
            'Returns persisted execution and canonical resolution separately from workflow phase. An unavailable workflow service does not imply success or no activity.',
        },
        timeline: {
          method: 'GET',
          path: '/v1/organizations/:organizationId/exceptions/:exceptionId/timeline',
          pathParams: caseParams,
          query: caseEvidenceQuerySchema,
          responses: { 200: caseTimelineSchema },
          summary: 'Read case audit history',
          description:
            'Returns up to 100 persisted events, ordered by timestamp and ID. Reuse cursors with the same organization, case and page size. Refresh from the first page and deduplicate by ID as events arrive.',
        },
      },
      {
        commonResponses: {
          401: apiErrorSchema,
          403: apiErrorSchema,
          404: apiErrorSchema,
          409: apiErrorSchema,
          503: apiErrorSchema,
        },
      },
    ),
    operations: c.router({
      overview: {
        method: 'GET',
        path: '/v1/organizations/:organizationId/operations/overview',
        pathParams: organizationParamsSchema,
        query: overviewQuerySchema,
        responses: {
          200: operationsOverviewSchema,
          401: apiErrorSchema,
          404: apiErrorSchema,
          503: apiErrorSchema,
        },
        summary: 'Read your operations overview',
        description:
          'Returns current attention and active counts, up to five decisions ordered by severity then oldest request, and verified resolutions in the selected rolling window [start, end). Connection freshness requires observations for every permitted read capability within 24 hours. Null automation metrics mean eligibility or human-work attribution is unavailable. Counts describe persisted cases; fresh observations do not establish complete source coverage.',
      },
    }),
    exceptions: c.router(
      {
        list: {
          method: 'GET',
          path: '/v1/organizations/:organizationId/exceptions',
          pathParams: organizationParamsSchema,
          query: caseQuerySchema,
          responses: { 200: caseListSchema },
          summary: 'List cases in your organization',
          description:
            'Filter attention, active work or history by class, severity and state. Results sort by severity, oldest attention request or detection, then ID. Use the returned cursor with the same filters. Refresh from the first page as cases change.',
        },
        evidence: {
          method: 'GET',
          path: '/v1/organizations/:organizationId/exceptions/:exceptionId/evidence',
          pathParams: organizationParamsSchema.extend({
            exceptionId: z.string().uuid(),
          }),
          query: caseEvidenceQuerySchema,
          responses: { 200: caseEvidencePageSchema },
          summary: 'Read case evidence references',
          description:
            'Returns persisted observation and verification references ordered by immutable ID, including evidence outside the current diagnosis. Pages default to 25 references and allow at most 100. Reuse cursors only for the same organization, case and page size. As evidence arrives, refresh from the first page and deduplicate by ID. Completeness is unknown unless explicitly recorded for the observation. A null source update time means unknown, regardless of observation freshness.',
        },
        get: {
          method: 'GET',
          path: '/v1/organizations/:organizationId/exceptions/:exceptionId',
          pathParams: organizationParamsSchema.extend({
            exceptionId: z.string().uuid(),
          }),
          responses: { 200: caseDetailSchema },
          summary: 'Read a case investigation',
          description:
            'Returns the current persisted investigation and up to 100 evidence references. Use the evidence endpoint to read further historical references. Recommendations require review; they do not authorize execution. Unavailable cases return not found.',
        },
      },
      {
        commonResponses: {
          401: apiErrorSchema,
          404: apiErrorSchema,
          503: apiErrorSchema,
        },
      },
    ),
    identity: identityContract,
    connections: connectionsContract,
    system: {
      health: {
        method: 'GET',
        path: '/health',
        responses: { 200: z.object({ status: z.literal('ok') }) },
        summary: 'Check whether the API is running',
      },
      ready: {
        method: 'GET',
        path: '/ready',
        responses: {
          200: z.object({ status: z.literal('ready') }),
          503: apiErrorSchema,
        },
        summary: 'Check whether the API is ready to serve requests',
        description:
          'Returns 200 when ready and 503 when temporarily unavailable.',
      },
    },
    connectorProviders: c.router(
      {
        list: {
          method: 'GET',
          path: '/connector-providers',
          query: z
            .object({ category: z.enum(['storefront', 'erp']).optional() })
            .strict(),
          responses: {
            200: z.object({ items: z.array(connectorProviderSchema) }),
          },
          summary: 'List connector providers',
          description:
            'Browse provider names and categories. Filter by storefront or ERP.',
        },
        get: {
          method: 'GET',
          path: '/connector-providers/:providerId',
          pathParams: z.object({
            providerId: z
              .string()
              .min(1)
              .max(64)
              .regex(/^[a-z][a-z0-9-]*$/),
          }),
          responses: { 200: connectorProviderSchema, 404: apiErrorSchema },
          summary: 'Get a connector provider',
          description:
            'Look up a provider by its ID. Returns 404 if the provider is not in the catalog.',
        },
      },
      { pathPrefix: '/v1' },
    ),
  },
  {
    strictStatusCodes: true,
    commonResponses: {
      400: apiErrorSchema,
      413: apiErrorSchema,
      415: apiErrorSchema,
      500: apiErrorSchema,
    },
  },
);
export { diagnosisSchema } from './diagnosis.js';
export type { Diagnosis } from './diagnosis.js';
