import { z } from 'zod';

const timestamp = z.string().datetime({ offset: true });

const syncRecordTypeSchema = z.enum([
  'orders',
  'fulfillments',
  'products',
  'inventory',
  'customers',
  'returns',
  'inventory_transfers',
  'inventory_shipments',
]);

const syncStatusSchema = z.enum([
  'paused',
  'blocked',
  'failing',
  'retrying',
  'waiting',
  'importing',
  'syncing',
  'up_to_date',
]);

const syncScanKindSchema = z.enum(['backfill', 'incremental', 'reconcile']);

export const syncStreamSchema = z.object({
  id: z.string().uuid(),
  status: syncStatusSchema,
  phase: z.enum(['backfill', 'incremental']),
  paused: z.boolean(),
  blocked: z
    .enum([
      'connection_inactive',
      'principal_unavailable',
      'capability_removed',
    ])
    .nullable(),
  scan: z
    .object({
      kind: syncScanKindSchema,
      startedAt: timestamp,
      since: timestamp.nullable(),
      createdSince: timestamp.nullable().optional(),
      waitingForExport: z.boolean().optional(),
      pages: z.number().int().nonnegative(),
      records: z.number().int().nonnegative(),
      total: z.number().int().nonnegative().nullable(),
    })
    .nullable(),
  records: z.object({
    total: z.number().int().nonnegative(),
    current: z.number().int().nonnegative(),
    pending: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    missing: z.number().int().nonnegative(),
    retired: z.number().int().nonnegative(),
  }),
  problems: z.array(z.string()),
  coverage: z.object({
    oldest: timestamp.nullable(),
    newest: timestamp.nullable(),
    historyFrom: timestamp.nullable(),
    historyRequirement: z.string().nullable(),
    olderHistoryAvailable: z.boolean(),
    recentFrom: timestamp.nullable().optional(),
    recentCompletedAt: timestamp.nullable().optional(),
  }),
  lastSuccessAt: timestamp.nullable(),
  lastCompleteAt: timestamp.nullable(),
  lastFullScanAt: timestamp.nullable(),
  backfillStartedAt: timestamp.nullable(),
  backfillCompletedAt: timestamp.nullable(),
  nextRunAt: timestamp.nullable(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
      at: timestamp,
      attempts: z.number().int().positive(),
    })
    .nullable(),
});

const syncConnectionSchema = z.object({
  connectionId: z.string().uuid(),
  label: z.string(),
  provider: z.string(),
  appId: z.string().nullable(),
  status: z.enum(['pending', 'active', 'degraded', 'disconnected', 'revoked']),
  recordTypes: z.array(
    z.object({
      recordType: syncRecordTypeSchema,
      availability: z.enum(['granted', 'not_granted', 'not_requested']),
      stream: syncStreamSchema.nullable(),
    }),
  ),
});

const syncRunSchema = z.object({
  id: z.string().uuid(),
  connectionId: z.string().uuid(),
  recordType: syncRecordTypeSchema,
  kind: syncScanKindSchema,
  trigger: z.enum(['connection', 'operator', 'schedule', 'webhook']),
  since: timestamp.nullable(),
  createdSince: timestamp.nullable().optional(),
  fullScan: z.boolean(),
  startedAt: timestamp,
  finishedAt: timestamp.nullable(),
  outcome: z.enum(['running', 'completed', 'cancelled']),
  pages: z.number().int().nonnegative(),
  records: z.number().int().nonnegative(),
  changed: z.number().int().nonnegative(),
  unchanged: z.number().int().nonnegative(),
  pending: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  missing: z.number().int().nonnegative().nullable(),
  errors: z.number().int().nonnegative(),
});

export const syncOverviewSchema = z.object({
  connections: z.array(syncConnectionSchema),
  runs: z.array(syncRunSchema),
  canManage: z.boolean(),
  asOf: timestamp,
});

export const syncCommandSchema = z
  .object({
    command: z.enum(['pause', 'resume', 'retry', 'reconcile', 'reimport']),
  })
  .strict();

export const identityKindSchema = z.enum([
  'sku',
  'location',
  'order',
  'order_line',
]);

export const linkRequestSchema = z.object({
  id: z.string().uuid(),
  kind: identityKindSchema,
  operation: z.enum(['link', 'unlink']),
  entityId: z.string().uuid(),
  otherId: z.string().uuid().nullable(),
  connectionId: z.string().uuid().nullable(),
  reason: z.string(),
  state: z.enum(['requested', 'running', 'completed', 'failed']),
  message: z.string().nullable(),
  createdAt: timestamp,
  completedAt: timestamp.nullable(),
});

const identitySourceSchema = z.object({
  connectionId: z.string().uuid(),
  connectionLabel: z.string(),
  provider: z.string(),
  externalId: z.string(),
  scopeKey: z.string(),
  method: z.string(),
  linkedAt: timestamp,
  revisedAt: timestamp.nullable(),
  order: z
    .object({
      number: z.string().nullable(),
      externalNumber: z.string().nullable(),
      placedAt: timestamp.nullable(),
      total: z.object({ amount: z.string(), currency: z.string() }).nullable(),
    })
    .optional(),
  codes: z.array(z.string()),
  titles: z.array(z.string()),
});

export const identityDetailSchema = z.object({
  entity: z.object({
    id: z.string().uuid(),
    kind: identityKindSchema,
    label: z.string(),
    orderId: z.string().uuid().optional(),
    unit: z.string().min(1).max(64).optional(),
  }),
  sources: z.array(identitySourceSchema),
  suggestions: z.array(
    z.object({
      id: z.string().uuid(),
      label: z.string(),
      reason: z.string(),
      sources: z.array(identitySourceSchema),
    }),
  ),
  requests: z.array(linkRequestSchema),
  canManage: z.boolean(),
});

export const linkInputSchema = z.discriminatedUnion('operation', [
  z
    .object({
      operation: z.literal('link'),
      kind: identityKindSchema,
      entityId: z.string().uuid(),
      otherId: z.string().uuid(),
      reason: z.string().trim().min(1).max(2000),
    })
    .strict(),
  z
    .object({
      operation: z.literal('unlink'),
      kind: identityKindSchema,
      entityId: z.string().uuid(),
      connectionId: z.string().uuid(),
      reason: z.string().trim().min(1).max(2000),
    })
    .strict(),
]);

export type SyncRecordType = z.infer<typeof syncRecordTypeSchema>;

export type SyncStreamView = z.infer<typeof syncStreamSchema>;

export type SyncConnectionView = z.infer<typeof syncConnectionSchema>;

export type SyncRunView = z.infer<typeof syncRunSchema>;

export type SyncOverview = z.infer<typeof syncOverviewSchema>;

export type SyncCommand = z.infer<typeof syncCommandSchema>['command'];

export type IdentityDetail = z.infer<typeof identityDetailSchema>;

export type LinkInput = z.infer<typeof linkInputSchema>;

export const autoLinkPairSchema = z
  .object({
    kind: z.enum(['sku', 'order']),
    targetConnectionId: z.string().uuid(),
    sourceConnectionId: z.string().uuid(),
  })
  .strict();

export const autoLinkInputSchema = autoLinkPairSchema
  .extend({
    id: z.string().uuid(),
    revision: z.number().int().nonnegative(),
    enabled: z.boolean(),
  })
  .strict();

export const autoLinkRuleSchema = autoLinkInputSchema.extend({
  principalId: z.string(),
  state: z.enum(['disabled', 'waiting', 'active', 'blocked', 'failed']),
  message: z.string().nullable(),
  lastCheckedAt: timestamp.nullable(),
  linked: z.number().int().nonnegative(),
});

export const autoLinkRulesSchema = z.array(autoLinkRuleSchema);

export const autoLinkPreviewSchema = z.object({
  ready: z.boolean(),
  message: z.string().nullable(),
  counts: z.object({
    eligible: z.number().int().nonnegative(),
    ambiguous: z.number().int().nonnegative(),
    conflict: z.number().int().nonnegative(),
    excluded: z.number().int().nonnegative(),
    stale: z.number().int().nonnegative(),
  }),
  candidates: z
    .array(
      z.object({
        key: z.string(),
        targetId: z.string().uuid(),
        sourceId: z.string().uuid(),
        disposition: z.enum([
          'eligible',
          'ambiguous',
          'conflict',
          'excluded',
          'stale',
        ]),
      }),
    )
    .max(20),
});

export type AutoLinkPair = z.infer<typeof autoLinkPairSchema>;

export type AutoLinkInput = z.infer<typeof autoLinkInputSchema>;

export type AutoLinkRule = z.infer<typeof autoLinkRuleSchema>;

export type AutoLinkPreview = z.infer<typeof autoLinkPreviewSchema>;
