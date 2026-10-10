import { AsyncLocalStorage } from 'node:async_hooks';

const requestScope = new AsyncLocalStorage<{ readOnly: boolean }>();

/**
 * Runs `operation` and everything it starts in a fresh request scope. Call it from the first
 * request hook, so later hooks can restrict the scope before handlers run.
 */
export function runInRequestScope<T>(operation: () => T): T {
  return requestScope.run({ readOnly: false }, operation);
}

/**
 * Makes the rest of the current request read-only: identity's settings transactions, and tenant
 * databases created with `readOnly: requestIsReadOnly`, open as `READ ONLY`, so PostgreSQL
 * rejects writes. Throws outside a request scope rather than silently allowing writes.
 */
export function restrictRequestToReads(): void {
  const scope = requestScope.getStore();
  if (!scope) throw new Error('No request scope to restrict.');
  scope.readOnly = true;
}

/** Reports whether the current request was restricted to reads. */
export function requestIsReadOnly(): boolean {
  return requestScope.getStore()?.readOnly === true;
}
