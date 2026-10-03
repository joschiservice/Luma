import {
  createWeightedPicker,
  keyedRandom,
  logNormal,
  unit,
} from './random.js';

/** Transport failures a provider API can produce. */
export const transportFaults = [
  'unavailable',
  'rate-limit',
  'server-error',
  'timeout',
  'reset',
  'malformed',
  'schema-drift',
] as const;

export type TransportFault = (typeof transportFaults)[number];

export interface LatencyProfile {
  medianMs: number;
  p99Ms: number;
}

export interface TransportChaos {
  /** Share of requests that fail before or around the provider's work, from 0 to 1. */
  errorRate: number;
  /** Relative weight of each failure kind. */
  mix: Record<TransportFault, number>;
  latency: LatencyProfile;
  /** Share of committed writes whose response never reaches the client. */
  responseLossRate: number;
  /** How long changed records stay invisible to filtered list and search reads. */
  indexLagMs: number;
  /** How long a simulated timeout holds the response before the connection closes. */
  timeoutMs: number;
  /** Enforces each provider's own request budget, such as Shopify's query-cost bucket. */
  rateLimits: boolean;
}

/** Changes transport behavior for one provider instance or operation. */
export interface ChaosOverride {
  instance?: string | undefined;
  operation?: string | undefined;
  errorRate?: number | undefined;
  mix?: Partial<Record<TransportFault, number>> | undefined;
  latency?: LatencyProfile | undefined;
}

/** A period in simulation time with a different failure rate, optionally repeating. */
export interface ChaosWindow {
  id: string;
  label: string;
  startsAt: number;
  durationMs: number;
  /** Repeats the window at this interval after `startsAt`. */
  everyMs?: number | undefined;
  instance?: string | undefined;
  operation?: string | undefined;
  errorRate: number;
  /** Forces one failure kind during the window. */
  fault?: TransportFault | undefined;
}

export interface WebhookChaos {
  dropRate: number;
  duplicateRate: number;
  /** Share of deliveries delayed long enough to arrive after later events. */
  reorderRate: number;
  delay: LatencyProfile;
}

export interface ChaosProfile {
  preset: string;
  transport: TransportChaos;
  overrides: ChaosOverride[];
  windows: ChaosWindow[];
  webhooks: WebhookChaos;
  /** Expected operational incidents per incident kind, in the unit each kind defines. */
  incidents: Record<string, number>;
}

/** The outcome chosen for one provider request. */
export interface ChaosDecision {
  fault: TransportFault | null;
  /** Whether a write fault happens after the provider committed the change. */
  afterCommit: boolean;
  /** Whether a successful write's response is lost. */
  lose: boolean;
  latencyMs: number;
  /** The window that caused the fault, if any. */
  window: string | null;
}

export interface ChaosRequest {
  seed: number;
  instance: string;
  operation: string;
  write: boolean;
  /** Stable request identity, such as method, URL and body digest. */
  identity: string;
  /** How often this identity was requested before; retries get independent decisions. */
  occurrence: number;
  /** Simulation time. */
  now: number;
}

/** Returns the window active at `now` for the target, if any. */
export function activeWindow(
  windows: readonly ChaosWindow[],
  instance: string,
  operation: string,
  now: number,
) {
  return windows.find((window) => {
    if (window.instance && window.instance !== instance) return false;
    if (window.operation && window.operation !== operation) return false;
    if (now < window.startsAt) return false;
    const elapsed = now - window.startsAt;
    const offset = window.everyMs ? elapsed % window.everyMs : elapsed;

    return offset < window.durationMs;
  });
}

/**
 * Decides a request's failure, latency and response loss. Decisions depend only on the seed,
 * request identity and occurrence, so a run with the same seed fails the same requests even
 * when concurrent clients send them in a different order.
 */
export function decide(
  profile: ChaosProfile,
  request: ChaosRequest,
): ChaosDecision {
  const key = [
    request.seed,
    request.instance,
    request.identity,
    request.occurrence,
  ];
  let errorRate = profile.transport.errorRate;
  let mix = profile.transport.mix;
  let latency = profile.transport.latency;
  for (const override of profile.overrides) {
    if (override.instance && override.instance !== request.instance) continue;
    if (override.operation && override.operation !== request.operation)
      continue;
    errorRate = override.errorRate ?? errorRate;
    mix = { ...mix, ...override.mix };
    latency = override.latency ?? latency;
  }
  const window = activeWindow(
    profile.windows,
    request.instance,
    request.operation,
    request.now,
  );
  if (window) errorRate = Math.max(errorRate, window.errorRate);
  let fault: TransportFault | null = null;
  if (unit(...key, 'fault') < errorRate)
    fault =
      window?.fault ??
      createWeightedPicker(
        transportFaults,
        transportFaults.map((kind) => Math.max(0, mix[kind] ?? 0)),
      )(keyedRandom(...key, 'kind'));
  // A write can time out, reset or fail after the provider applied it; its effect is unknown.
  const afterCommit =
    request.write &&
    (fault === 'timeout' || fault === 'reset' || fault === 'server-error') &&
    unit(...key, 'phase') < 0.5;

  return {
    fault,
    afterCommit,
    lose:
      request.write &&
      !fault &&
      unit(...key, 'loss') < profile.transport.responseLossRate,
    latencyMs: Math.round(
      logNormal(
        keyedRandom(...key, 'latency'),
        latency.medianMs,
        latency.p99Ms,
      ),
    ),
    window: window && fault ? window.id : null,
  };
}

/** Decides whether a webhook delivery is dropped, duplicated or delayed. */
export function decideWebhook(
  profile: ChaosProfile,
  seed: number,
  eventId: string,
) {
  const webhooks = profile.webhooks;
  const draw = (part: string) => unit(seed, 'webhook', eventId, part);
  const reordered = draw('reorder') < webhooks.reorderRate;

  return {
    drop: draw('drop') < webhooks.dropRate,
    duplicate: draw('duplicate') < webhooks.duplicateRate,
    delayMs: Math.round(
      logNormal(
        keyedRandom(seed, 'webhook', eventId, 'delay'),
        webhooks.delay.medianMs,
        webhooks.delay.p99Ms,
      ) + (reordered ? webhooks.delay.p99Ms : 0),
    ),
  };
}
