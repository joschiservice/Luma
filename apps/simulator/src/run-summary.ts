import type { Run } from './run.js';

/** Returns control-panel metadata without provider records or journal history. */
export function summarizeRun(run: Run) {
  return {
    id: run.id,
    seed: run.seed,
    scenario: run.scenario,
    clock: {
      now: run.clock.now,
      running: run.clock.running,
      speed: run.clock.speed,
      scheduledEvents: run.clock.events.length,
    },
    serviceHealth: run.serviceHealth,
    operationalScenarios: run.operationalScenarios,
  };
}
