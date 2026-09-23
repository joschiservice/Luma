export type PerformanceOperation =
  | 'db.transaction'
  | 'detection.evaluate'
  | 'diagnosis.evaluate'
  | 'policy.evaluate';

/** Records fixed operation names without inspecting work inputs or results. */
export interface PerformanceAdapter {
  sync<T>(operation: PerformanceOperation, work: () => T): T;
  async<T>(operation: PerformanceOperation, work: () => Promise<T>): Promise<T>;
}

const passthrough: PerformanceAdapter = {
  sync: (_operation, work) => work(),
  async: (_operation, work) => work(),
};
let adapter = passthrough;

/** Installs process-wide diagnostics at startup; the returned function restores the previous adapter. */
export function installPerformance(next: PerformanceAdapter): () => void {
  const previous = adapter;
  adapter = next;

  return () => {
    adapter = previous;
  };
}

/** Times a synchronous algorithm using the installed adapter, or runs directly when disabled. */
export function measureSync<T>(
  operation: PerformanceOperation,
  work: () => T,
): T {
  return adapter.sync(operation, work);
}

/** Times asynchronous work using the installed adapter, or runs directly when disabled. */
export function measure<T>(
  operation: PerformanceOperation,
  work: () => Promise<T>,
): Promise<T> {
  return adapter.async(operation, work);
}
