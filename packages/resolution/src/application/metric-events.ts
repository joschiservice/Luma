/** A scoped wake-up requests a fresh authorized read; it never carries business data. */
interface MetricWakeup {
  tenantId?: string;
  connected: boolean;
  /** Areas that changed. Absent after a reconnection or an untagged change: reconcile all. */
  topics?: readonly string[];
}

/** Shares a process listener. Subscribers must reauthorize before delivering an event. */
export interface MetricEvents {
  readonly connected: boolean;
  /** Registers before the initial read and returns an idempotent unsubscribe function. */
  subscribe(tenantId: string, wake: (event: MetricWakeup) => void): () => void;
}
