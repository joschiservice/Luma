/** How a request for a sandbox process slot ended. */
export type SlotAdmission = 'admitted' | 'cancelled' | 'busy';

/**
 * Shares a fixed number of process slots between tenants. A tenant holds at most `perTenant`
 * slots, so the rest stay open to others; waiting tenants take turns for each freed slot and
 * each tenant's runs start in arrival order. A wait ends as `busy` after `waitMs` or
 * `cancelled` when its signal aborts. Every admission must be followed by exactly one
 * `release` for the same tenant.
 */
export function createSlotQueue(options: {
  slots: number;
  perTenant: number;
  waitMs: number;
}) {
  let active = 0;
  const running = new Map<string, number>();
  // Map order is the turn order: a tenant moves to the back after each admission.
  const waiting = new Map<string, (() => void)[]>();

  function leave(tenantId: string, admit: () => void) {
    const queue = waiting.get(tenantId);
    const index = queue?.indexOf(admit) ?? -1;
    if (index < 0) return;
    queue!.splice(index, 1);
    if (!queue!.length) waiting.delete(tenantId);
  }

  // Admits waiting runs in turn order while slots are free, skipping tenants at their limit.
  function admitWaiting() {
    while (active < options.slots) {
      const next = [...waiting].find(
        ([tenantId]) => (running.get(tenantId) ?? 0) < options.perTenant,
      );
      if (!next) return;
      const [tenantId, queue] = next;
      const admit = queue.shift()!;
      waiting.delete(tenantId);
      if (queue.length) waiting.set(tenantId, queue);
      active++;
      running.set(tenantId, (running.get(tenantId) ?? 0) + 1);
      admit();
    }
  }

  return {
    /** Waits for a free slot for the tenant without holding the caller's wall-time budget. */
    acquire(tenantId: string, signal?: AbortSignal): Promise<SlotAdmission> {
      if (signal?.aborted) return Promise.resolve('cancelled');

      return new Promise((resolve) => {
        const settle = (admission: SlotAdmission) => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', cancel);
          resolve(admission);
        };
        const admit = () => settle('admitted');
        const cancel = () => {
          leave(tenantId, admit);
          settle('cancelled');
        };
        const timer = setTimeout(() => {
          leave(tenantId, admit);
          settle('busy');
        }, options.waitMs);
        signal?.addEventListener('abort', cancel, { once: true });
        const queue = waiting.get(tenantId);
        if (queue) queue.push(admit);
        else waiting.set(tenantId, [admit]);
        admitWaiting();
      });
    },
    /** Frees the tenant's slot and admits the next eligible waiting run. */
    release(tenantId: string) {
      active--;
      const count = (running.get(tenantId) ?? 1) - 1;
      if (count) running.set(tenantId, count);
      else running.delete(tenantId);
      admitWaiting();
    },
  };
}
