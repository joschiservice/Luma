import { ActivityFailure, ApplicationFailure } from '@temporalio/common';
import { sleep } from '@temporalio/workflow';

/** The failure type of an activity whose workspace is suspended or closed. */
export const workspaceInactiveFailure = 'WorkspaceInactive';

/** The failure type of an activity whose acting member's access is suspended or account disabled. */
export const membershipSuspendedFailure = 'MembershipSuspended';

const firstCheckMs = 60_000;
const longestCheckMs = 3_600_000;

function inactive(error: unknown) {
  return (
    error instanceof ActivityFailure &&
    error.cause instanceof ApplicationFailure &&
    (error.cause.type === workspaceInactiveFailure ||
      error.cause.type === membershipSuspendedFailure)
  );
}

/**
 * Wraps workflow activity proxies so a suspended or closed workspace, or a suspended acting
 * member or disabled account, pauses the workflow instead of failing it. The activity is called again after a
 * durable wait that doubles from one minute to one hour, which bounds history growth during a
 * long suspension. The rejected attempt ran no effect, because activities resolve the tenant
 * context before they act. Call only from workflow code.
 */
export function pauseWhileInactive<T extends object>(activities: T): T {
  return new Proxy(activities, {
    get(target, name, receiver) {
      const activity: unknown = Reflect.get(target, name, receiver);
      if (typeof activity !== 'function') return activity;

      return async (...args: unknown[]) => {
        let wait = firstCheckMs;
        for (;;) {
          try {
            const result: unknown = await Reflect.apply(activity, target, args);

            return result;
          } catch (error) {
            if (!inactive(error)) throw error;
            await sleep(wait);
            wait = Math.min(wait * 2, longestCheckMs);
          }
        }
      };
    },
  });
}
