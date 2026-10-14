import { z } from 'zod';

/**
 * Record lists that people can configure, save as views and resume. Each domain is one list
 * page; its catalog says which fields can be filtered, sorted, grouped and shown.
 */
export const collectionDomainSchema = z.enum([
  'orders',
  'customers',
  'fulfillment',
  'products',
  'inventory',
  'transfers',
  'returns',
  'procurement',
  'suppliers',
  'issues',
  'decisions',
  'inbox',
  'activity',
]);

/**
 * Condition operators. `empty` means the source reported no value; `unknown` means Luma has not
 * read the value or cannot see it. Neither ever matches a comparison such as `eq 0`.
 */
const collectionOperatorSchema = z.enum([
  'is',
  'is_not',
  'any_of',
  'none_of',
  'all_of',
  'contains',
  'not_contains',
  'eq',
  'ne',
  'gt',
  'gte',
  'lt',
  'lte',
  'between',
  'before',
  'after',
  'within_last',
  'within_next',
  'empty',
  'not_empty',
  'unknown',
]);

export const collectionLayoutSchema = z.enum(['table', 'list', 'board']);

const collectionDensitySchema = z.enum(['comfortable', 'compact']);

const collectionGranularitySchema = z.enum(['day', 'week', 'month']);

const scalar = z.union([z.string().max(500), z.number().finite(), z.boolean()]);

/** Resolved for each reader at read time, so one shared view serves everyone. */
const dynamicValue = z.object({ dynamic: z.enum(['me', 'today']) }).strict();

/** A relative period such as the last 7 days, resolved in the workspace time zone. */
const relativeValue = z
  .object({
    amount: z.number().int().min(0).max(3660),
    unit: collectionGranularitySchema,
  })
  .strict();

/** Amounts compare only within one currency. */
const moneyValue = z
  .object({
    amount: z.string().regex(/^-?\d{1,14}(\.\d{1,6})?$/),
    currency: z.string().regex(/^[A-Z]{3}$/),
  })
  .strict();

const rangeBound = z.union([scalar, moneyValue, dynamicValue]).nullable();

const rangeValue = z
  .object({ from: rangeBound, to: rangeBound })
  .strict()
  .refine((range) => range.from !== null || range.to !== null, {
    message: 'A range needs at least one bound',
  });

const collectionValueSchema = z.union([
  scalar,
  dynamicValue,
  relativeValue,
  moneyValue,
  rangeValue,
  z
    .array(z.union([scalar, dynamicValue]))
    .min(1)
    .max(50),
]);

/**
 * Which source a value comes from, for fields that every connected source reports separately:
 * a connection ID, `any` source, `every` source or the `lowest` reported quantity.
 */
const collectionSourceScopeSchema = z.union([
  z.enum(['any', 'every', 'lowest']),
  z.string().uuid(),
]);

const fieldId = z
  .string()
  .regex(/^(?:[a-z][a-zA-Z0-9]{0,63}|custom:[0-9a-f-]{36})$/);

const collectionConditionSchema = z
  .object({
    field: fieldId,
    op: collectionOperatorSchema,
    value: collectionValueSchema.optional(),
    source: collectionSourceScopeSchema.optional(),
  })
  .strict();

export const collectionWhereSchema = z
  .object({
    match: z.enum(['all', 'any']).default('all'),
    conditions: z.array(collectionConditionSchema).max(20).default([]),
  })
  .strict();

const jsonParameter = <T extends z.ZodType>(schema: T, max: number) =>
  z
    .string()
    .max(max)
    .transform((text, context) => {
      try {
        return JSON.parse(text) as unknown;
      } catch {
        context.addIssue({ code: 'custom', message: 'Expected JSON' });

        return z.NEVER;
      }
    })
    .pipe(schema);

/** The `where` list parameter: JSON-encoded conditions, at most 8,000 characters. */
export const collectionWhereParameter = jsonParameter(
  collectionWhereSchema,
  8000,
).describe(
  'JSON-encoded conditions: `{"match":"all"|"any","conditions":[{"field","op","value","source"}]}`. Fields and operators follow the list catalog; unsupported combinations return 400.',
);

/** The `group` list parameter: a groupable field, optionally with a date granularity. */
export const collectionGroupParameter = z
  .string()
  .regex(
    /^(?:[a-z][a-zA-Z0-9]{0,63}|custom:[0-9a-f-]{36})(?::(?:day|week|month))?$/,
  )
  .transform((text) => {
    const [field = '', granularity] = text.split(/:(?=day$|week$|month$)/);

    return {
      field,
      granularity: collectionGranularitySchema.optional().parse(granularity),
    };
  })
  .describe(
    'Group rows by a field, such as `status` or `placed:week`. Each group returns its count and its first rows.',
  );

const groupKeySchema = z.union([
  z.string().max(500),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);

/** The `groupKey` list parameter: the JSON-encoded key of one group, to page within it. */
export const collectionGroupKeyParameter = jsonParameter(
  groupKeySchema,
  1024,
).describe(
  'JSON-encoded group key from `groups[].key`, such as `"open"`, `true` or `null`, to read more rows of one group. Requires `group`.',
);

/** The `groupLimit` list parameter: rows returned per group when reading every group. */
export const collectionGroupLimitParameter = z.coerce
  .number()
  .int()
  .min(1)
  .max(50)
  .default(10)
  .describe('Rows returned per group, from 1 to 50.');

/** Whether the runtime can convert instants to wall-clock time in `value`. */
function knownTimeZone(value: string) {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });

    return true;
  } catch {
    return false;
  }
}

/** The `timeZone` list parameter: the reader's IANA zone for calendar-relative conditions. */
export const collectionTimeZoneParameter = z
  .string()
  .min(1)
  .max(64)
  .refine(knownTimeZone, 'Use an IANA time zone, such as Europe/Berlin')
  .default('UTC')
  .describe(
    'Days, weeks and months in conditions such as `today` or `within_last`, and date groups, follow this time zone.',
  );

/** One group of a grouped list. `complete` is false when the count may be missing records. */
export const collectionGroupSchema = z.object({
  key: z.union([z.string(), z.number(), z.boolean(), z.null()]),
  count: z.number().int().nonnegative(),
  complete: z.boolean(),
  itemIds: z.array(z.string()).max(100),
  nextCursor: z.string().nullable(),
  sums: z
    .array(
      z.object({
        field: z.string(),
        currency: z.string().nullable(),
        amount: z.string(),
      }),
    )
    .max(20)
    .default([]),
});

const collectionSortSchema = z
  .object({ field: fieldId, direction: z.enum(['asc', 'desc']) })
  .strict();

const collectionGroupingSchema = z
  .object({
    field: fieldId,
    granularity: collectionGranularitySchema.optional(),
    showEmpty: z.boolean().default(false),
  })
  .strict();

export const collectionColumnSchema = z
  .object({
    id: fieldId,
    width: z.number().int().min(48).max(960).optional(),
  })
  .strict();

/**
 * The shareable state of a list page. Search text and page position are never part of it.
 * Empty `columns` and `properties` mean the page defaults.
 */
export const collectionViewStateSchema = z
  .object({
    segment: z
      .string()
      .regex(/^[a-z][a-z_]{0,59}$/)
      .nullable()
      .default(null),
    where: collectionWhereSchema.default({ match: 'all', conditions: [] }),
    sort: collectionSortSchema.nullable().default(null),
    group: collectionGroupingSchema.nullable().default(null),
    layout: collectionLayoutSchema.default('table'),
    density: collectionDensitySchema.default('comfortable'),
    columns: z.array(collectionColumnSchema).max(40).default([]),
    properties: z.array(fieldId).max(20).default([]),
    preview: z.boolean().default(false),
  })
  .strict()
  .superRefine((state, context) => {
    if (state.layout === 'board' && !state.group)
      context.addIssue({
        code: 'custom',
        message: 'Board layout requires grouping',
        path: ['group'],
      });
    if (
      new Set(state.columns.map((column) => column.id)).size !==
      state.columns.length
    )
      context.addIssue({
        code: 'custom',
        message: 'Columns must be unique',
        path: ['columns'],
      });
  });

/** Display settings each member keeps for a view without changing it for others. */
const collectionPersonalDisplaySchema = z
  .object({
    density: collectionDensitySchema.optional(),
    widths: z
      .record(fieldId, z.number().int().min(48).max(960))
      .refine((widths) => Object.keys(widths).length <= 40)
      .default({}),
    collapsedGroups: z.array(z.string().max(200)).max(100).default([]),
  })
  .strict();

/**
 * Identifies the view a page shows: a saved view ID, or `builtin:<segment>` for one of the
 * page's built-in views.
 */
const collectionViewKeySchema = z
  .string()
  .regex(/^(?:builtin:[a-z][a-z_]{0,59}|[0-9a-f-]{36})$/);

/**
 * What a member last had open on one list page, synced across their devices. `draft` holds
 * unsaved changes on top of `view`, recorded against `baseRevision` of a saved view.
 */
export const collectionMemberStateSchema = z
  .object({
    view: collectionViewKeySchema.nullable(),
    baseRevision: z.number().int().positive().nullable(),
    draft: collectionViewStateSchema.nullable(),
    defaultView: collectionViewKeySchema.nullable(),
    order: z.array(collectionViewKeySchema).max(250).default([]),
    display: z
      .record(collectionViewKeySchema, collectionPersonalDisplaySchema)
      .refine((display) => Object.keys(display).length <= 100)
      .default({}),
  })
  .strict();

export const collectionMemberStateResponseSchema = z.object({
  domain: collectionDomainSchema,
  state: collectionMemberStateSchema.nullable(),
  sequence: z.number().int().nonnegative(),
  updatedAt: z.string().datetime().nullable(),
});

export const saveCollectionMemberStateSchema = z
  .object({
    state: collectionMemberStateSchema,
    /** Increases with every save from one client; older saves are ignored. */
    sequence: z.number().int().positive(),
  })
  .strict();

/** Permission needed to read each list; null when every member may open it. */
export const collectionPermissions: Record<
  z.infer<typeof collectionDomainSchema>,
  string | null
> = {
  orders: 'orders.read',
  customers: 'customers.read',
  fulfillment: 'fulfillment.read',
  products: 'products.read',
  inventory: 'inventory.read',
  transfers: 'inventory.read',
  returns: 'returns.read',
  procurement: 'procurement.read',
  suppliers: 'procurement.read',
  issues: 'issues.read',
  decisions: null,
  inbox: 'messages.read',
  activity: 'activity.read',
};

export type CollectionDomain = z.infer<typeof collectionDomainSchema>;

export type CollectionFieldType =
  | 'text'
  | 'enum'
  | 'tags'
  | 'number'
  | 'money'
  | 'date'
  | 'boolean'
  | 'person'
  | 'reference';

export type CollectionOperator = z.infer<typeof collectionOperatorSchema>;

export type CollectionLayout = z.infer<typeof collectionLayoutSchema>;

export type CollectionDensity = z.infer<typeof collectionDensitySchema>;

export type CollectionGranularity = z.infer<typeof collectionGranularitySchema>;

export type CollectionCondition = z.infer<typeof collectionConditionSchema>;

export type CollectionWhere = z.infer<typeof collectionWhereSchema>;

export type CollectionGroup = z.infer<typeof collectionGroupSchema>;

export type CollectionSort = z.infer<typeof collectionSortSchema>;

export type CollectionGrouping = z.infer<typeof collectionGroupingSchema>;

export type CollectionColumn = z.infer<typeof collectionColumnSchema>;

export type CollectionViewState = z.infer<typeof collectionViewStateSchema>;

export type CollectionPersonalDisplay = z.infer<
  typeof collectionPersonalDisplaySchema
>;

export type CollectionMemberState = z.infer<typeof collectionMemberStateSchema>;

export type CollectionMemberStateResponse = z.infer<
  typeof collectionMemberStateResponseSchema
>;
