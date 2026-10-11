import type { ChaosProfile } from './chaos.js';
import { type IncidentKindName, incidentKindNames } from './incidents.js';

const hour = 3_600_000;

const incidents = (
  rates: Partial<Record<IncidentKindName, number>>,
  scale = 1,
): Record<IncidentKindName, number> =>
  Object.fromEntries(
    incidentKindNames.map((kind) => [kind, (rates[kind] ?? 0) * scale]),
  ) as Record<IncidentKindName, number>;

const realisticIncidents = {
  'inventory-drift': 1,
  oversell: 0.3,
  'order-import-failure': 0.5,
  'warehouse-stall': 0.5,
  'shipment-sync-failure': 0.5,
  'fraud-hold': 1,
  'carrier-delay': 5,
  'lost-parcel': 0.5,
  'refund-failure': 2,
  // Injected from scenarios only; the merchant world doesn't produce them on its own.
  'refund-missing': 0,
  'payment-stuck': 0,
  'supplier-silent': 0,
  'supplier-split-delivery-mail': 0,
  'customer-delay-mail': 0,
  'shipping-method-mismatch': 0.5,
  'provider-outage': 0.5,
  'auth-revoked': 0.05,
} satisfies Record<IncidentKindName, number>;

const realistic: ChaosProfile = {
  preset: 'realistic',
  transport: {
    errorRate: 0.003,
    mix: {
      unavailable: 30,
      'rate-limit': 20,
      'server-error': 15,
      timeout: 10,
      reset: 10,
      malformed: 8,
      'schema-drift': 7,
    },
    latency: { medianMs: 120, p99Ms: 1_500 },
    responseLossRate: 0.002,
    indexLagMs: 3_000,
    timeoutMs: 20_000,
    rateLimits: true,
  },
  // An on-premises ERP behind a tunnel fails more often than a hosted shop API.
  overrides: [{ instance: 'jtl', errorRate: 0.01 }],
  windows: [],
  webhooks: {
    dropRate: 0.005,
    duplicateRate: 0.02,
    reorderRate: 0.01,
    delay: { medianMs: 1_500, p99Ms: 30_000 },
  },
  incidents: incidents(realisticIncidents),
};

/**
 * Named failure profiles. Realistic is the default: everyday development sees occasional
 * transport failures, lagging search results, duplicate webhooks and operational incidents.
 */
export const chaosPresets = {
  calm: {
    preset: 'calm',
    transport: {
      ...realistic.transport,
      errorRate: 0,
      latency: { medianMs: 5, p99Ms: 30 },
      responseLossRate: 0,
      indexLagMs: 0,
      rateLimits: false,
    },
    overrides: [],
    windows: [],
    webhooks: {
      dropRate: 0,
      duplicateRate: 0,
      reorderRate: 0,
      delay: { medianMs: 200, p99Ms: 1_000 },
    },
    incidents: incidents({}),
  },
  realistic,
  'bad-day': {
    preset: 'bad-day',
    transport: {
      ...realistic.transport,
      errorRate: 0.08,
      latency: { medianMs: 400, p99Ms: 6_000 },
      responseLossRate: 0.01,
      indexLagMs: 15_000,
    },
    overrides: [],
    windows: [
      {
        id: 'shop-degraded',
        label: 'Shops degraded every three hours',
        startsAt: 0,
        durationMs: 15 * 60_000,
        everyMs: 3 * hour,
        errorRate: 0.5,
      },
    ],
    webhooks: {
      dropRate: 0.03,
      duplicateRate: 0.05,
      reorderRate: 0.05,
      delay: { medianMs: 5_000, p99Ms: 120_000 },
    },
    incidents: incidents(realisticIncidents, 3),
  },
  'outage-drill': {
    ...realistic,
    preset: 'outage-drill',
    windows: [
      {
        id: 'hourly-outage',
        label: 'All providers unavailable for 10 minutes every hour',
        startsAt: 0,
        durationMs: 10 * 60_000,
        everyMs: hour,
        errorRate: 1,
        fault: 'unavailable',
      },
    ],
  },
} satisfies Record<string, ChaosProfile>;

export type ChaosPresetName = keyof typeof chaosPresets;

/** Returns a copy of a preset that callers may change. */
export function chaosPreset(name: ChaosPresetName): ChaosProfile {
  return structuredClone(chaosPresets[name]);
}
