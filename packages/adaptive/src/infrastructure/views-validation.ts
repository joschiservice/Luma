import {
  adaptiveViewDraftSchema,
  adaptiveViewInputSchema,
  adaptiveViewPreviewSchema,
  adaptiveViewQuerySchema,
  adaptiveViewRevisionSchema,
  adaptiveViewSchema,
  caseQuerySchema,
  customerQuerySchema,
  decisionQuerySchema,
  fulfillmentQuerySchema,
  inventoryQuerySchema,
  orderListQuerySchema,
  productQuerySchema,
} from '@luma/api-contract';
import { IdentityError } from '@luma/identity';
import type { JsonValue, ModelSchema } from '@luma/platform';
import { z } from 'zod';

import type {
  AdaptiveViewDraft,
  AdaptiveViewInput,
  AdaptiveViewPreview,
  AdaptiveViewQuery,
} from '../domain/views.js';

const ownerQueries = {
  orders: orderListQuerySchema,
  inventory: inventoryQuerySchema,
  fulfillment: fulfillmentQuerySchema,
  customers: customerQuerySchema,
  products: productQuerySchema,
  procurement: z
    .object({
      attention: z
        .enum(['confirmation_overdue', 'delivery_overdue'])
        .optional(),
      supplierId: z.string().uuid().optional(),
      status: z.string().max(80).optional(),
    })
    .strict(),
  issues: caseQuerySchema,
  decisions: decisionQuerySchema.strict(),
};

/** Validates against each owner's vocabulary; unsupported predicates fail before a read. */
function ownerViewQuery(
  query: AdaptiveViewQuery,
  cursor?: string,
): Record<string, unknown> {
  if (
    ['cursor', 'limit', 'count', 'sort', 'direction'].some((key) =>
      Object.hasOwn(query.filters, key),
    )
  )
    throw new IdentityError(
      422,
      'VALIDATION_ERROR',
      'Pagination and sorting belong to the query controls.',
    );
  const schema = ownerQueries[query.domain];
  const raw: Record<string, unknown> = { ...query.filters };
  if (query.sort) {
    raw.sort = query.sort.field;
    if (query.domain !== 'fulfillment') raw.direction = query.sort.direction;
    else if (query.sort.direction !== 'desc')
      throw new IdentityError(
        422,
        'VALIDATION_ERROR',
        'Fulfillment sorting uses its supported priority order.',
      );
  }
  if (cursor) raw.cursor = cursor;
  if (query.domain === 'orders') raw.count = 'exact';
  const parsed = schema.safeParse(raw);
  if (!parsed.success)
    throw new IdentityError(
      422,
      'VALIDATION_ERROR',
      'This domain does not support one of the requested filters or sort fields.',
    );

  return parsed.data;
}

function jsonValue(value: unknown): JsonValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    typeof value === 'number'
  )
    return value;
  if (Array.isArray(value)) return value.map(jsonValue);
  if (typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, jsonValue(entry)]),
    );
  throw new Error('Invalid JSON schema');
}

const draftSchema = adaptiveViewDraftSchema.omit({ preview: true });
const rawJson = z.toJSONSchema(draftSchema);

export const viewDraftModelSchema: ModelSchema<
  Omit<AdaptiveViewDraft, 'preview'>
> = {
  name: 'adaptive_view_draft',
  jsonSchema: Object.fromEntries(
    Object.entries(rawJson).map(([key, value]) => [key, jsonValue(value)]),
  ),
  parse: (value) => draftSchema.parse(value),
};

export const viewsValidation = {
  query: (value: unknown): AdaptiveViewQuery =>
    adaptiveViewQuerySchema.parse(value),
  input: (value: unknown): AdaptiveViewInput =>
    adaptiveViewInputSchema.parse(value),
  preview: (value: unknown): AdaptiveViewPreview =>
    adaptiveViewPreviewSchema.parse(value),
  prompt: (value: unknown): string =>
    z.string().trim().min(1).max(2000).parse(value),
  ownerQuery: ownerViewQuery,
};

/** Validates a stored view without granting presentation permissions. */
export function parseStoredView(value: unknown) {
  return adaptiveViewSchema.omit({ canEdit: true }).parse(value);
}

/** Validates one immutable saved-query revision. */
export const parseViewRevision = (value: unknown) =>
  adaptiveViewRevisionSchema.parse(value);
