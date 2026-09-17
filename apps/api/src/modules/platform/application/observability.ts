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
    model: 'test-model';
    inputTokens: number;
    outputTokens: number;
  }): void;
}

export interface Observability {
  request(requestId: string, actionId?: string): Observation;
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
  capture(context: TraceContext, event: ProductEvent): void;
  flag(
    context: TraceContext,
    flag: FeatureFlag,
    fallback?: boolean,
  ): Promise<boolean>;
  shutdown(): Promise<void>;
}
