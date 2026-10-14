import { z } from 'zod';

import {
  adaptiveRecordTypeSchema,
  customFieldInputSchema,
  customFieldQueryResultSchema,
  customFieldQuerySchema,
  customFieldRecordSchema,
  customFieldRecordsSchema,
  customFieldSchema,
  customFieldValueSchema,
  fieldWorkflowReviewSchema,
} from '../adaptive-fields.js';
import { endpoint, organizationParamsSchema, requires } from '../common.js';

const fieldParams = organizationParamsSchema.extend({
  fieldId: z.string().uuid(),
});
const recordParams = organizationParamsSchema.extend({
  recordType: adaptiveRecordTypeSchema,
  recordId: z.string().uuid(),
});
const root = '/v1/organizations/{organizationId}/adaptive/fields';

export const adaptiveFieldsContract = {
  workflowPending: endpoint
    .route({
      method: 'GET',
      path: `${root}/workflow-pending`,
      summary: 'Read pending custom field approvals',
      description:
        'Read policy-bound custom field proposals your role may see. Filter by the affected record to show its waiting proposals.',
    })
    .meta({
      access: requires('adaptive.fields.read'),
      errors: [401, 403, 404, 503],
    })
    .input(
      z.object({
        params: organizationParamsSchema,
        query: z.object({
          recordType: adaptiveRecordTypeSchema.optional(),
          recordId: z.string().uuid().optional(),
        }),
      }),
    )
    .output(z.array(fieldWorkflowReviewSchema)),
  workflowReview: endpoint
    .route({
      method: 'GET',
      path: `${root}/workflow-runs/{runId}/steps/{stepId}`,
      summary: 'Review a workflow field change',
      description:
        'Read the exact before and proposed typed values, policy decision, expiry and current revisions before responding.',
    })
    .meta({
      access: requires('adaptive.fields.read'),
      errors: [401, 403, 404, 503],
    })
    .input(
      z.object({
        params: organizationParamsSchema.extend({
          runId: z.string().uuid(),
          stepId: z.string().min(1).max(200),
        }),
      }),
    )
    .output(fieldWorkflowReviewSchema),
  workflowDecide: endpoint
    .route({
      method: 'POST',
      path: `${root}/workflow-runs/{runId}/steps/{stepId}/decision`,
      summary: 'Approve or reject a workflow field change',
      description:
        'Respond to the reviewed policy decision. Stale field or value revisions and mismatched review fingerprints are refused. Approval grants only this immutable proposal; the worker rechecks permission and policy before writing.',
    })
    .meta({
      access: requires('decisions.respond'),
      errors: [401, 403, 404, 409, 503],
    })
    .input(
      z.object({
        params: organizationParamsSchema.extend({
          runId: z.string().uuid(),
          stepId: z.string().min(1).max(200),
        }),
        body: z
          .object({
            decisionId: z.string().uuid(),
            reviewedActionHash: z.string().min(1).max(200),
            outcome: z.enum(['approved', 'rejected']),
          })
          .strict(),
      }),
    )
    .output(fieldWorkflowReviewSchema),
  list: endpoint
    .route({
      method: 'GET',
      path: root,
      summary: 'List custom fields',
      description:
        'Read fields that your role may see for this record type. Archived fields are excluded unless requested.',
    })
    .meta({
      access: requires('adaptive.fields.read'),
      errors: [401, 403, 404, 503],
    })
    .input(
      z.object({
        params: organizationParamsSchema,
        query: z.object({
          recordType: adaptiveRecordTypeSchema,
          includeArchived: z
            .union([
              z.boolean(),
              z.enum(['true', 'false']).transform((value) => value === 'true'),
            ])
            .default(false),
        }),
      }),
    )
    .output(z.array(customFieldSchema)),
  create: endpoint
    .route({
      method: 'POST',
      path: root,
      summary: 'Define a custom field',
      description:
        'Create a typed Luma field with German and English labels and permission gates from the catalog. Repeat the same commandId to recover its result.',
    })
    .meta({
      access: requires('adaptive.fields.manage'),
      errors: [401, 403, 409, 422, 503],
    })
    .input(
      z.object({
        params: organizationParamsSchema,
        body: customFieldInputSchema.extend({ commandId: z.string().uuid() }),
      }),
    )
    .output(customFieldSchema),
  update: endpoint
    .route({
      method: 'PUT',
      path: `${root}/{fieldId}`,
      summary: 'Update a custom field',
      description:
        'Change labels, permissions and choices using the current revision. Changing type or removing choices is refused while values exist.',
    })
    .meta({
      access: requires('adaptive.fields.manage'),
      errors: [401, 403, 404, 409, 422, 503],
    })
    .input(
      z.object({
        params: fieldParams,
        body: customFieldInputSchema.extend({
          revision: z.number().int().positive(),
        }),
      }),
    )
    .output(customFieldSchema),
  restore: endpoint
    .route({
      method: 'POST',
      path: `${root}/{fieldId}/restore`,
      summary: 'Restore an archived custom field',
      description:
        'Make an archived Luma field visible again with its existing values and history. Provider-observed fields cannot be restored through this command.',
    })
    .meta({
      access: requires('adaptive.fields.manage'),
      errors: [401, 403, 404, 409, 503],
    })
    .input(
      z.object({
        params: fieldParams,
        body: z.object({ revision: z.number().int().positive() }).strict(),
      }),
    )
    .output(customFieldSchema),
  archive: endpoint
    .route({
      method: 'POST',
      path: `${root}/{fieldId}/archive`,
      summary: 'Archive a custom field',
      description:
        'Hide a field from active record views while retaining values and change history.',
    })
    .meta({
      access: requires('adaptive.fields.manage'),
      errors: [401, 403, 404, 409, 503],
    })
    .input(
      z.object({
        params: fieldParams,
        body: z.object({ revision: z.number().int().positive() }).strict(),
      }),
    )
    .output(customFieldSchema),
  readMany: endpoint
    .route({
      method: 'POST',
      path: `${root}/records/{recordType}/values`,
      summary: 'Read custom field values of several records',
      description:
        'Reads permitted fields and their values for up to 100 records of one type, as list columns show them. Records you cannot see return no values; records without values are absent.',
    })
    .meta({
      access: requires('adaptive.fields.read'),
      readOnly: true,
      errors: [401, 403, 422, 503],
    })
    .input(
      z.object({
        params: organizationParamsSchema.extend({
          recordType: adaptiveRecordTypeSchema,
        }),
        body: z
          .object({ recordIds: z.array(z.string().uuid()).min(1).max(100) })
          .strict(),
      }),
    )
    .output(customFieldRecordsSchema),
  readValues: endpoint
    .route({
      method: 'GET',
      path: `${root}/records/{recordType}/{recordId}`,
      summary: 'Read record custom fields',
      description:
        'Read permitted fields and their values on a record you can access. Provider-observed fields remain read-only.',
    })
    .meta({
      access: requires('adaptive.fields.read'),
      errors: [401, 403, 404, 503],
    })
    .input(z.object({ params: recordParams }))
    .output(customFieldRecordSchema),
  writeValues: endpoint
    .route({
      method: 'PUT',
      path: `${root}/records/{recordType}/{recordId}`,
      summary: 'Edit record custom fields',
      description:
        'Atomically change typed Luma-owned values and record who changed each field. Use revision 0 for an unset field or its current value revision. Stale changes are refused; null clears a field.',
    })
    .meta({
      access: requires('adaptive.fields.write'),
      errors: [401, 403, 404, 409, 422, 503],
    })
    .input(
      z.object({
        params: recordParams,
        body: z
          .object({
            values: z
              .array(
                z
                  .object({
                    fieldId: z.string().uuid(),
                    value: customFieldValueSchema,
                    revision: z.number().int().nonnegative(),
                  })
                  .strict(),
              )
              .min(1)
              .max(50),
          })
          .strict(),
      }),
    )
    .output(customFieldRecordSchema),
  query: endpoint
    .route({
      method: 'POST',
      path: `${root}/query`,
      summary: 'Query custom field records',
      description:
        'Filter, sort and group supported records by fields your role can see. Predicates run before pagination; returns record identities for domain detail views. Group counts include unset values and are capped at 100 groups.',
    })
    .meta({
      access: requires('adaptive.fields.read'),
      errors: [401, 403, 422, 503],
    })
    .input(
      z.object({
        params: organizationParamsSchema,
        body: customFieldQuerySchema,
      }),
    )
    .output(customFieldQueryResultSchema),
  history: endpoint
    .route({
      method: 'GET',
      path: `${root}/{fieldId}/history`,
      summary: 'Read custom field history',
      description:
        'Read the latest 100 immutable definition changes, or value changes for one record, with actor identity and timestamps.',
    })
    .meta({
      access: requires('adaptive.fields.read'),
      errors: [401, 403, 404, 503],
    })
    .input(
      z.object({
        params: fieldParams,
        query: z.object({ recordId: z.string().uuid().optional() }),
      }),
    )
    .output(
      z.array(
        z.object({
          id: z.string().uuid(),
          fieldId: z.string().uuid(),
          recordId: z.string().uuid().nullable(),
          actorId: z.string().uuid(),
          occurredAt: z.string().datetime(),
          before: z.unknown(),
          after: z.unknown(),
          kind: z.enum([
            'created',
            'updated',
            'archived',
            'restored',
            'value_changed',
          ]),
        }),
      ),
    ),
};
