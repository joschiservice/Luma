export * from './chaos.js';

export * from './faults.js';

export * from './incidents.js';

export * from './presets.js';

export * from './protocol.js';

export * from './random.js';

export * from './rate-limit.js';

export * from './store.js';

/** One ordered entry in a run's activity journal. */
export interface JournalEntry {
  sequence: number;
  /** Simulation time in epoch milliseconds. */
  time: number;
  kind: string;
  instance?: string | undefined;
  resource?: string | undefined;
  detail: unknown;
}
