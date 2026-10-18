import type { DataRegion } from './model-gateway.js';

export type Operation =
  | 'api.request'
  | 'workflow.run'
  | 'agent.run'
  | 'model.generate'
  | 'tool.execute';

type ProductEvent =
  'connector_provider_viewed' | 'observability_test_completed';

/** Flag keys that may be evaluated; add a key here before creating it in PostHog. */
export const featureFlags = [
  'observability-test',
  'staff-regional-directory',
  'contextual-record-assistance',
  'operational-morning-brief',
  'action-review-diffs',
  'scoped-autonomy',
  'stock-protection',
  'resolution-insights',
  'active-diagnosis',
  'workflow-improvements',
  'workflow-red-teaming',
  'workflow-improvement-discovery',
  'adaptive-custom-fields',
  'adaptive-saved-views',
  'adaptive-view-generation',
  'adaptive-view-actions',
  'adaptive-operational-packages',
  'luma-erp-orders',
  'starshipit-fulfillment',
  'starshipit-actions',
  'shopify-shipment-publishing',
  'supplier-purchasing-terms',
  'purchasing-workbench',
  'purchasing-plans',
  'purchasing-receipts',
  'purchasing-shortfall-decisions',
  'procurement-supplier-follow-ups',
  'procurement-email-submission',
  'purchasing-order-changes',
  'purchasing-stock-booking',
  'purchasing-outcomes',
  'purchasing-incoming',
] as const;

export type FeatureFlag = (typeof featureFlags)[number];

/** Correlation is diagnostic metadata, never proof of tenant access. */
export interface TraceContext {
  readonly traceId: string;
  readonly spanId: string;
  readonly requestId: string;
  readonly actionId?: string;
  readonly tenantRef?: string;
}

export interface Observation {
  readonly context: TraceContext;
  end(status?: 'ok' | 'error'): void;
  generation(usage: {
    model: string;
    inputTokens: number;
    outputTokens: number;
    costUsd?: number | null;
    latencyMs?: number;
  }): void;
}

export interface ActivityFailureContext {
  workflowId: string;
  workflowRunId: string;
  activityId: string;
  activityType: string;
  attempt: number;
  taskQueue: string;
  namespace: string;
  /** Server request ID that started the workflow, when its input carries one. */
  requestId?: string;
}

/** Request facts for an unexpected HTTP failure; the adapter redacts them before export. */
export interface HttpFailureContext {
  method: string;
  /** Route pattern, such as `/v1/organizations/:organizationId/cases`. */
  route: string;
  /** Path and query string as received. */
  url: string;
  headers?: Readonly<Record<string, string | string[] | undefined>>;
}

/** Where an unexpected failure happened. Messages are fixed operation descriptions. */
interface FailureContext {
  context?: TraceContext;
  request?: HttpFailureContext;
  message?: string;
}

export interface Observability {
  /** Configured processing cell; absent only on test doubles. */
  readonly dataRegion?: DataRegion;
  request(
    requestId: string,
    actionId?: string,
    http?: { route: string; method: string },
  ): Observation;
  /** Runs a request continuation under its diagnostic span without changing tenant authorization. */
  withContext?<T>(context: TraceContext, work: () => T): T;
  /** Tenant ID must come from authorized identity context, never request headers. */
  forTenant(
    context: TraceContext,
    tenantId: string,
    dataRegion: DataRegion,
  ): TraceContext;
  run<T>(
    parent: TraceContext,
    operation: Operation,
    work: (context: TraceContext, observation: Observation) => Promise<T>,
  ): Promise<T>;
  /**
   * Reports an unexpected failure with its message, stack and causes to Sentry and, in local
   * diagnostics, to the trace and log stream. URLs and sensitive headers are redacted.
   */
  captureError(error: unknown, failure?: FailureContext): void;
  /**
   * Reports the original activity exception with Temporal identifiers to Sentry and, in local
   * diagnostics, to the log stream.
   */
  captureActivityError(error: unknown, context: ActivityFailureContext): void;
  /** Sends a product event to PostHog in staging and production; elsewhere it does nothing. */
  capture(context: TraceContext, event: ProductEvent): void;
  /**
   * Evaluates a release flag for the context's tenant, or its action or request when no tenant
   * is bound. A configured override wins. Development and test never ask PostHog and return
   * `fallback`; staging and production also return it when PostHog is unconfigured, unreachable,
   * has not loaded definitions yet or does not know the flag. Never use a flag as an
   * authorization, policy or approval decision.
   */
  flag(
    context: TraceContext,
    flag: FeatureFlag,
    fallback?: boolean,
  ): Promise<boolean>;
  shutdown(): Promise<void>;
}
