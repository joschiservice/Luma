import { setTimeout as delay } from 'node:timers/promises';

/**
 * Runs imports independently of the pilot's detection and setup work. Each loop waits after
 * its pass finishes, never overlaps itself, and drains its current work before stopping.
 * Provider adapters retain their shared request admission and canonical writes retain their locks.
 */
export function startPilotBackgroundWork(
  pilot,
  log,
  { syncIntervalMs = 2_000, maintenanceIntervalMs = 60_000 } = {},
) {
  const controller = new AbortController();
  const { signal } = controller;

  async function loop(work, intervalMs) {
    while (!signal.aborted) {
      await work();
      try {
        await delay(intervalMs, undefined, { signal });
      } catch (error) {
        if (!signal.aborted) throw error;
      }
    }
  }

  const imports = loop(
    () =>
      pilot
        .observe({ passes: 1, refresh: false, check: false })
        .catch((error) => log('Pilot sync pass failed', error)),
    syncIntervalMs,
  );
  const maintenance = loop(async () => {
    for (const step of [
      pilot.link,
      pilot.demo,
      pilot.quantityChanges,
      pilot.checkInventory,
      pilot.detect,
    ]) {
      if (signal.aborted) break;
      await step().catch((error) => log('Pilot sync step failed', error));
    }
  }, maintenanceIntervalMs);

  return async () => {
    controller.abort();
    await Promise.all([imports, maintenance]);
  };
}
