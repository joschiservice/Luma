import { z } from 'zod';

/** Explicit opt-in for one ERP → Shopify pair; disabling requires an active-hold disposition. */
export const stockProtectionSettingsSchema = z
  .object({
    connectionId: z.string().uuid(),
    sourceConnectionId: z.string().uuid(),
    revision: z.number().int().nonnegative().default(0),
    mode: z.enum(['off', 'preview', 'on']).default('off'),
    riskThreshold: z.number().int().min(0).max(2147483647).default(10),
    includeSalesRate: z.boolean().default(false),
    bufferUnits: z.number().int().min(0).max(2147483647).default(2),
    bufferPercent: z.number().min(0).max(100).default(20),
    keepSellable: z.number().int().min(0).max(2147483647).default(0),
    maxSkus: z.number().int().min(1).max(2000).default(200),
    maxUnitsPerSku: z.number().int().min(1).max(2147483647).default(100),
    dailyUnits: z.number().int().min(1).max(2147483647).default(20000),
    maxDurationSeconds: z.number().int().min(60).max(604800).default(21600),
    durationAction: z.enum(['escalate', 'release']).default('escalate'),
    exclusions: z
      .object({
        skus: z.array(z.string().min(1).max(200)).max(1000).default([]),
        tags: z.array(z.string().min(1).max(200)).max(1000).default([]),
        collections: z.array(z.string().min(1).max(200)).max(1000).default([]),
      })
      .strict()
      .default({ skus: [], tags: [], collections: [] }),
  })
  .strict();

export type StockProtectionSettings = z.infer<
  typeof stockProtectionSettingsSchema
>;

const stockProtectionStatusSchema = z.enum([
  'pending',
  'preview',
  'held',
  'tightened',
  'releasing',
  'released',
  'released_by_sync',
  'changed_outside_luma',
  'skipped',
  'not_protected',
  'unknown',
]);

/** Retained per-position explanation. Unknown outcomes retain their original action identity. */
const stockProtectionPositionSchema = z.object({
  id: z.string().uuid(),
  positionId: z.string().uuid(),
  skuId: z.string().uuid(),
  sku: z.string().nullable(),
  title: z.string().nullable(),
  status: stockProtectionStatusSchema,
  reason: z.string().nullable(),
  before: z.number().int().nullable(),
  authority: z.number().int().nullable(),
  held: z.number().int().nullable(),
  current: z.number().int().nullable(),
  startedAt: z.string().datetime().nullable(),
  endedAt: z.string().datetime().nullable(),
  unitMilliseconds: z.number().nonnegative(),
  exposedUnits: z.number().int().nonnegative(),
  actionId: z.string().uuid().nullable(),
});

export type StockProtectionPosition = z.infer<
  typeof stockProtectionPositionSchema
>;

export const stockProtectionQuerySchema = z
  .object({
    incidentId: z.string().uuid().optional(),
    positionId: z.string().uuid().optional(),
    skuId: z.string().uuid().optional(),
    offset: z.number().int().min(0).max(10000).default(0),
    limit: z.number().int().min(0).max(200).default(0),
  })
  .strict();

export const stockProtectionIncidentSchema = z.object({
  requesterId: z.string().optional(),
  canApprove: z.boolean().optional(),
  positionCount: z.number().int().nonnegative().optional(),
  protectedCount: z.number().int().nonnegative().optional(),
  exposedSkus: z.number().int().nonnegative().optional(),
  heldCount: z.number().int().nonnegative().optional(),
  uncertainCount: z.number().int().nonnegative().optional(),
  pendingCount: z.number().int().nonnegative().optional(),
  unitHours: z.number().nonnegative().optional(),
  exposedUnits: z.number().nonnegative().optional(),
  positionsTruncated: z.boolean().optional(),
  id: z.string().uuid(),
  connectionId: z.string().uuid(),
  sourceConnectionId: z.string().uuid(),
  label: z.string(),
  mode: z.enum(['preview', 'on']),
  state: z.enum([
    'active',
    'approval_required',
    'escalated',
    'released',
    'unknown',
  ]),
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime().nullable(),
  deadline: z.string().datetime(),
  releaseRequested: z.boolean(),
  stopNew: z.boolean(),
  decisionId: z.string().uuid().nullable(),
  positions: z.array(stockProtectionPositionSchema),
});

export type StockProtectionIncident = z.infer<
  typeof stockProtectionIncidentSchema
>;

export const stockProtectionViewSchema = z.object({
  enabled: z.boolean(),
  canManage: z.boolean(),
  settings: z.array(stockProtectionSettingsSchema),
  incidents: z.array(stockProtectionIncidentSchema),
  pairs: z.array(
    z.object({
      connectionId: z.string().uuid(),
      sourceConnectionId: z.string().uuid(),
      label: z.string(),
    }),
  ),
});

export type StockProtectionView = z.infer<typeof stockProtectionViewSchema>;
