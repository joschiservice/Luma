import { AsyncLocalStorage } from 'node:async_hooks';

import { ConnectorError } from './index.js';

const dispatchGuard = new AsyncLocalStorage<{
  check(firstDispatch?: boolean): Promise<void>;
  dispatched: boolean;
  tracked: boolean;
  stageAdvanced: boolean;
}>();

/** Carries execution's final authority check through an adapter without changing provider inputs. */
export async function withDispatchGuard<T>(
  guard: ((firstDispatch?: boolean) => Promise<void>) | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  if (!guard) return operation();
  const scope = {
    check: guard,
    dispatched: false,
    tracked: false,
    stageAdvanced: false,
  };

  return dispatchGuard.run(scope, async () => {
    try {
      return await operation();
    } catch (error) {
      if (
        scope.dispatched &&
        error instanceof ConnectorError &&
        error.failure.effect === 'none' &&
        (scope.stageAdvanced || error.failure.dispatch !== 'not_dispatched')
      ) {
        throw new ConnectorError({
          ...error.failure,
          effect: 'unknown',
          dispatch: 'uncertain',
          retry: 'reconcile',
        });
      }
      if (
        !scope.dispatched &&
        error instanceof ConnectorError &&
        scope.tracked
      ) {
        throw new ConnectorError({
          ...error.failure,
          effect: 'none',
          dispatch: 'not_dispatched',
        });
      }
      throw error;
    }
  });
}

/** Opts a mutation transport into dispatch tracking before it attempts admission. */
export function markDispatchPreparing(): void {
  const scope = dispatchGuard.getStore();
  if (scope) {
    scope.tracked = true;
    if (scope.dispatched) scope.stageAdvanced = true;
  }
}

/** Rechecks execution authority after transport admission and credential refresh, before a mutation is sent. */
export async function assertDispatchAllowed(): Promise<void> {
  const scope = dispatchGuard.getStore();
  if (!scope) return;
  scope.tracked = true;
  if (scope.dispatched) scope.stageAdvanced = true;
  await scope.check(!scope.dispatched);
}

/** Marks an attempted network mutation so a later denial cannot erase an earlier uncertain effect. */
export function markDispatchStarted(): void {
  const scope = dispatchGuard.getStore();
  if (scope) {
    if (scope.dispatched) scope.stageAdvanced = true;
    scope.dispatched = true;
  }
}
