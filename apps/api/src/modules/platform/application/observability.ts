export type Operation =
  | 'api.request'
  | 'workflow.run'
  | 'agent.run'
  | 'model.generate'
  | 'tool.execute';

export type ProductEvent =
  'connector_provider_viewed' | 'observability_test_completed';

export type FeatureFlag = 'observability-test';

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
}

export interface Observability {
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
    dataRegion: 'EU',
  ): TraceContext;
  run<T>(
    parent: TraceContext,
    operation: Operation,
    work: (context: TraceContext, observation: Observation) => Promise<T>,
  ): Promise<T>;
  captureError(context: TraceContext): void;
  /** Captures the original activity exception and Temporal identifiers in Sentry when configured. */
  captureActivityError(error: unknown, context: ActivityFailureContext): void;
  capture(context: TraceContext, event: ProductEvent): void;
  flag(
    context: TraceContext,
    flag: FeatureFlag,
    fallback?: boolean,
  ): Promise<boolean>;
  shutdown(): Promise<void>;
}
