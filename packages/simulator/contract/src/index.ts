import {
  faultKinds,
  incidentKindNames,
  type JournalEntry,
  transportFaults,
  type WorkflowScenarioName,
  workflowScenarioNames,
} from '@luma/simulator-core';
import { z } from 'zod';

const name = z.string().regex(/^[a-z0-9-]{1,64}$/);
const rate = z.number().min(0).max(1);
const latency = z.object({
  medianMs: z.number().min(0).max(600_000),
  p99Ms: z.number().min(0).max(3_600_000),
});

export const runIdSchema = name;

export const instanceSchema = name;

const transportFaultSchema = z.enum(transportFaults);

const incidentKindSchema = z.enum(
  incidentKindNames as [
    (typeof incidentKindNames)[number],
    ...(typeof incidentKindNames)[number][],
  ],
);

/** Transport, webhook and incident behavior of a run. */
export const chaosProfileSchema = z.object({
  preset: z.string().max(64),
  transport: z.object({
    errorRate: rate,
    mix: z.partialRecord(transportFaultSchema, z.number().min(0).max(1000)),
    latency,
    responseLossRate: rate,
    indexLagMs: z.number().int().min(0).max(3_600_000),
    timeoutMs: z.number().int().min(1_000).max(120_000),
    rateLimits: z.boolean(),
  }),
  overrides: z
    .array(
      z.object({
        instance: name.optional(),
        operation: z.string().max(80).optional(),
        errorRate: rate.optional(),
        mix: z
          .partialRecord(transportFaultSchema, z.number().min(0).max(1000))
          .optional(),
        latency: latency.optional(),
      }),
    )
    .max(50),
  windows: z
    .array(
      z.object({
        id: name,
        label: z.string().min(1).max(120),
        startsAt: z.number().int().min(0),
        durationMs: z
          .number()
          .int()
          .min(1_000)
          .max(7 * 86_400_000),
        everyMs: z
          .number()
          .int()
          .min(60_000)
          .max(30 * 86_400_000)
          .optional(),
        instance: name.optional(),
        operation: z.string().max(80).optional(),
        errorRate: rate,
        fault: transportFaultSchema.optional(),
      }),
    )
    .max(50),
  webhooks: z.object({
    dropRate: rate,
    duplicateRate: rate,
    reorderRate: rate,
    delay: latency,
  }),
  incidents: z.partialRecord(incidentKindSchema, z.number().min(0).max(10_000)),
});

export type ChaosProfileInput = z.infer<typeof chaosProfileSchema>;

export const createRunSchema = z.object({
  id: runIdSchema,
  seed: z.number().int().min(0).max(4_294_967_295).default(44),
  /** Merchant profile preset name. */
  profile: name.default('large'),
  /**
   * The merchant's ERP: JTL-Wawi or Cin7 Core. The profile's usual ERP when omitted; another
   * ERP runs the same merchant to test compatibility.
   */
  erp: z.enum(['jtl', 'cin7']).optional(),
  /**
   * Days of order history simulated before the run starts; the profile's when omitted. Fewer
   * days start faster, which matters most on Cin7 with its request limit.
   */
  historyDays: z.number().min(0).max(14).optional(),
  /** Optional per-run merchant stock-sync cadence; zero disables scheduled pushes. */
  stockSyncEveryMs: z.number().int().min(0).max(86400000).optional(),
  /** Chaos preset name or a complete profile. */
  chaos: z.union([name, chaosProfileSchema]).default('realistic'),
  /** Runs start in real time; paused runs only change through controls. */
  running: z.boolean().default(true),
});

export type CreateRun = z.infer<typeof createRunSchema>;

export const faultRuleSchema = z.object({
  instance: name,
  operation: z.string().min(1).max(80),
  resource: z.string().min(1).max(200).optional(),
  kind: z.enum(faultKinds),
  occurrence: z.number().int().min(1).max(10_000).default(1),
  remaining: z.number().int().min(1).max(10_000).default(1),
  lifetimeMs: z.number().int().positive().max(86_400_000).optional(),
});

const serviceHealthSchema = z.enum([
  'healthy',
  'rate-limited',
  'unavailable',
  'unauthorized',
]);

/** A merchant action that goes through the simulated integration, like a real shop order. */
export const orderActionSchema = z.object({
  action: z.literal('order'),
  shop: name.optional(),
  /** Explicit lines; a basket is drawn from the shop's assortment when omitted. */
  lines: z
    .array(
      z.object({
        sku: z.string().min(1).max(100),
        quantity: z.number().int().min(1).max(1000),
      }),
    )
    .min(1)
    .max(50)
    .optional(),
  shipping: z.enum(['standard', 'express']).optional(),
});

export const controlSchema = z.discriminatedUnion('action', [
  z.object({ action: z.enum(['pause', 'resume', 'reset']) }),
  z.object({
    action: z.literal('advance'),
    milliseconds: z.number().int().min(0).max(86_400_000),
  }),
  z.object({ action: z.literal('speed'), speed: z.number().min(0.1).max(100) }),
  z.object({
    action: z.literal('command'),
    instance: name,
    command: z.record(z.string(), z.unknown()),
  }),
  orderActionSchema,
  /** A retail account books a wholesale order directly in the ERP; needs a wholesale profile. */
  z.object({ action: z.literal('wholesale-order') }),
  z.object({ action: z.literal('fault'), rule: faultRuleSchema }),
  z.object({ action: z.literal('disable'), id: z.string().min(1).max(80) }),
  z.object({
    action: z.literal('service-health'),
    instance: name,
    status: serviceHealthSchema,
  }),
  z.object({
    action: z.literal('chaos'),
    chaos: z.union([name, chaosProfileSchema]),
  }),
]);

export type Control = z.infer<typeof controlSchema>;

export const injectIncidentSchema = z
  .object({
    /** Client-chosen UUID; repeating it returns the existing incident without another change. */
    id: z.string().uuid(),
    kind: incidentKindSchema,
    /** Share of the store catalogue stalled; defaults to all SKUs. */
    sharePercent: z.number().int().min(1).max(100).optional(),
    instance: name.optional(),
    /** SKU code, order name or numeric record ID, depending on the kind. */
    target: z.string().min(1).max(120).optional(),
  })
  .strict();

export type InjectIncident = z.infer<typeof injectIncidentSchema>;

/** Starts a workflow scenario; repeating the ID returns its incidents without another change. */
export const runScenarioSchema = z
  .object({
    id: z.string().uuid(),
    scenario: z.enum(
      workflowScenarioNames as [
        WorkflowScenarioName,
        ...WorkflowScenarioName[],
      ],
    ),
  })
  .strict();

export type RunScenario = z.infer<typeof runScenarioSchema>;

export const webhookTargetsSchema = z.object({
  targets: z
    .array(
      z.object({
        instance: name,
        url: z.string().url(),
        secret: z.string().min(16).max(256),
      }),
    )
    .max(20),
});

export const journalQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(100),
  before: z.coerce
    .number()
    .int()
    .positive()
    .max(Number.MAX_SAFE_INTEGER)
    .optional(),
  kind: z.string().max(40).optional(),
  instance: name.optional(),
});

export const recordQuerySchema = z.object({
  kind: z.string().min(1).max(60),
  after: z.string().max(80).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  parent: z.string().max(200).optional(),
});

export const metricsQuerySchema = z.object({
  /** Window length in simulation milliseconds. */
  windowMs: z.coerce
    .number()
    .int()
    .min(60_000)
    .max(7 * 86_400_000)
    .default(3_600_000),
});

/** Run lifecycle shown in run lists. */
export interface RunSummary {
  id: string;
  seed: number;
  profile: { name: string; label: string };
  status: 'provisioning' | 'ready' | 'failed';
  progress: { step: string; done: number; total: number } | null;
  error: string | null;
  clock: {
    now: number;
    running: boolean;
    speed: number;
    /**
     * Simulation time minus real time: positive after advancing or fast-forwarding, negative
     * while a paused or catching-up run is behind.
     */
    offsetMs: number;
    scheduledEvents: number;
  };
  chaos: { preset: string };
  instances: {
    name: string;
    kind: 'shopify' | 'jtl' | 'cin7' | 'gmail' | 'starshipit';
    label: string;
    health: z.infer<typeof serviceHealthSchema>;
  }[];
  counts: { orders: number; activeIncidents: number };
  createdAt: number;
}

export interface RunDetail extends RunSummary {
  chaosProfile: z.infer<typeof chaosProfileSchema>;
  merchant: {
    description: string;
    ordersPerDay: number;
    /** Wholesale orders per weekday booked directly in the ERP; 0 without wholesale. */
    wholesaleOrdersPerDay: number;
    /** Currency the ERP books in. */
    baseCurrency: string;
    autonomous: boolean;
    variants: number;
    shops: {
      instance: string;
      name: string;
      domain: string;
      currency: string;
      /** Numeric ID of the shop location that mirrors ERP stock. */
      location: string;
    }[];
    warehouses: { id: string; name: string; picksPerHour: number }[];
    /** Shared operations mailboxes; Luma reads them through the Gmail app. */
    mailboxes: { instance: string; address: string; name: string }[];
  };
  faults: {
    id: string;
    instance: string;
    operation: string;
    resource?: string | undefined;
    kind: string;
    occurrence: number;
    remaining: number;
    /** Simulation time after which the rule no longer applies. */
    expiresAt: number | null;
    status: string;
  }[];
  webhooks: { instance: string; url: string }[];
}

export interface IncidentView {
  id: string;
  kind: z.infer<typeof incidentKindSchema>;
  label: string;
  /** Planned incidents wait for their order to reach the affected step, such as shipping. */
  status: 'planned' | 'active' | 'recovered';
  origin: 'injected' | 'emerged';
  startedAt: number;
  endedAt: number | null;
  instance: string | null;
  summary: string;
  resources: { instance: string; kind: string; id: string; label: string }[];
  expected: { exceptionClass: string | null; surface: string };
  detection: {
    state: 'detected' | 'missed' | 'pending' | 'not-covered';
    caseId: string | null;
    caseUrl: string | null;
    detectedAt: number | null;
    resolved: boolean;
    verified: boolean;
    /** The latest workflow run Luma started for the case, if any. */
    workflow: { name: string; state: string; url: string } | null;
  } | null;
}

export interface Scorecard {
  generatedAt: number;
  luma: { connected: boolean; error: string | null };
  totals: {
    incidents: number;
    detected: number;
    missed: number;
    pending: number;
    notCovered: number;
    falsePositives: number;
    closedWithoutVerification: number;
    duplicateWrites: number;
  };
  meanTimeToDetectMs: number | null;
  byKind: {
    kind: string;
    label: string;
    exceptionClass: string | null;
    total: number;
    detected: number;
    missed: number;
    pending: number;
    notCovered: number;
    meanTimeToDetectMs: number | null;
  }[];
  falsePositives: {
    id: string;
    exceptionClass: string;
    detectedAt: string;
    url: string | null;
  }[];
  duplicateWrites: {
    instance: string;
    operation: string;
    key: string;
    count: number;
  }[];
}

export interface MetricSeries {
  name: string;
  instance: string | null;
  points: [number, number][];
}

export interface Metrics {
  bucketMs: number;
  from: number;
  to: number;
  series: MetricSeries[];
}

export interface SkuComparison {
  sku: string;
  name: string;
  erp: {
    instance: string;
    itemId: string;
    total: number;
    reserved: number;
    available: number;
    warehouses: Record<string, number>;
  } | null;
  shops: {
    instance: string;
    variant: string;
    location: string;
    onHand: number;
    committed: number;
    available: number;
    /** Shop availability minus ERP availability. */
    drift: number | null;
  }[];
  incidents: string[];
}

export interface Profiles {
  merchants: {
    name: string;
    label: string;
    description: string;
    /** The ERP a run uses unless it chooses another. */
    erp: 'jtl' | 'cin7';
    ordersPerDay: number;
    /** Wholesale orders per weekday booked directly in the ERP. */
    wholesaleOrdersPerDay: number;
    variants: number;
    shops: number;
    warehouses: number;
  }[];
  chaos: { name: string; profile: z.infer<typeof chaosProfileSchema> }[];
  incidents: {
    kind: string;
    label: string;
    description: string;
    unit: 'order' | 'day';
    exceptionClass: string | null;
    surface: string;
  }[];
}

/** Journal entries newest first. */
export interface JournalPage {
  items: JournalEntry[];
  /** Pass as `before` to read older entries; null when none remain. */
  nextCursor: number | null;
}

export interface RecordKindCount {
  kind: string;
  count: number;
}

/** A provider record as stored by the simulated provider. */
export interface ProviderRecord {
  kind: string;
  id: string;
  parent: string | null;
  key: string | null;
  createdAt: number;
  updatedAt: number;
  data: unknown;
}

export interface RecordPage {
  items: ProviderRecord[];
  next: string | null;
}

export interface SkuMatch {
  sku: string;
  name: string;
}

/** Luma's inventory check for a run, reported by the local pilot when one is attached. */
export interface OperationsStatus {
  connected: boolean;
  unavailable?: boolean | undefined;
  lastCheck?: {
    at: string;
    outcome: 'detect' | 'clear' | 'defer' | 'unavailable';
    reason?: string | undefined;
  } | null;
  incident?: { id: string; state: string } | null;
  caseUrl?: string | null;
}
