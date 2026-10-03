import {
  type ChaosProfileInput,
  chaosProfileSchema,
} from '@luma/simulator-contract';
import { type TransportFault, transportFaults } from '@luma/simulator-core';

import { formatDuration, formatLatency, formatPercent } from './format';

export type ChaosProfile = ChaosProfileInput;

export type ChaosOverride = ChaosProfile['overrides'][number];

export type ChaosWindow = ChaosProfile['windows'][number];

/** An edited chaos profile and the applied profile it started from. */
export interface ChaosDraft {
  profile: ChaosProfile;
  /** Whether the draft differs from what the run last reported. */
  dirty: boolean;
}

/** Marks an edited profile so the run no longer reports it as an unchanged preset. */
export const customPreset = 'custom';

export type ChaosAction =
  | { type: 'load'; profile: ChaosProfile }
  | { type: 'preset'; profile: ChaosProfile }
  | {
      type: 'transport';
      field: 'errorRate' | 'responseLossRate' | 'indexLagMs' | 'timeoutMs';
      value: number;
    }
  | { type: 'rate-limits'; value: boolean }
  | { type: 'mix'; fault: TransportFault; value: number }
  | {
      type: 'latency';
      target: 'transport' | 'webhooks';
      field: 'medianMs' | 'p99Ms';
      value: number;
    }
  | {
      type: 'webhooks';
      field: 'dropRate' | 'duplicateRate' | 'reorderRate';
      value: number;
    }
  | { type: 'incident'; kind: string; value: number }
  | { type: 'add-override'; override: ChaosOverride }
  | { type: 'update-override'; index: number; override: ChaosOverride }
  | { type: 'remove-override'; index: number }
  | { type: 'add-window'; window: ChaosWindow }
  | { type: 'update-window'; index: number; window: ChaosWindow }
  | { type: 'remove-window'; index: number };

const edit = (profile: ChaosProfile): ChaosDraft => ({
  profile: { ...profile, preset: customPreset },
  dirty: true,
});

/**
 * Applies one edit to a chaos draft. `load` replaces the draft with the run's applied profile;
 * `preset` starts from a named preset; every other edit marks the profile custom.
 */
export function chaosReducer(
  draft: ChaosDraft,
  action: ChaosAction,
): ChaosDraft {
  const profile = draft.profile;
  switch (action.type) {
    case 'load':
      return { profile: structuredClone(action.profile), dirty: false };
    case 'preset':
      return { profile: structuredClone(action.profile), dirty: true };
    case 'transport':
      return edit({
        ...profile,
        transport: { ...profile.transport, [action.field]: action.value },
      });
    case 'rate-limits':
      return edit({
        ...profile,
        transport: { ...profile.transport, rateLimits: action.value },
      });
    case 'mix':
      return edit({
        ...profile,
        transport: {
          ...profile.transport,
          mix: { ...profile.transport.mix, [action.fault]: action.value },
        },
      });
    case 'latency':
      return action.target === 'transport'
        ? edit({
            ...profile,
            transport: {
              ...profile.transport,
              latency: {
                ...profile.transport.latency,
                [action.field]: action.value,
              },
            },
          })
        : edit({
            ...profile,
            webhooks: {
              ...profile.webhooks,
              delay: {
                ...profile.webhooks.delay,
                [action.field]: action.value,
              },
            },
          });
    case 'webhooks':
      return edit({
        ...profile,
        webhooks: { ...profile.webhooks, [action.field]: action.value },
      });
    case 'incident':
      return edit({
        ...profile,
        incidents: { ...profile.incidents, [action.kind]: action.value },
      });
    case 'add-override':
      return edit({
        ...profile,
        overrides: [...profile.overrides, action.override],
      });
    case 'update-override':
      return edit({
        ...profile,
        overrides: profile.overrides.map((override, index) =>
          index === action.index ? action.override : override,
        ),
      });
    case 'remove-override':
      return edit({
        ...profile,
        overrides: profile.overrides.filter(
          (_, index) => index !== action.index,
        ),
      });
    case 'add-window':
      return edit({ ...profile, windows: [...profile.windows, action.window] });
    case 'update-window':
      return edit({
        ...profile,
        windows: profile.windows.map((window, index) =>
          index === action.index ? action.window : window,
        ),
      });
    case 'remove-window':
      return edit({
        ...profile,
        windows: profile.windows.filter((_, index) => index !== action.index),
      });
  }
}

/** Returns an unused window ID that satisfies the run's naming rule. */
export function nextWindowId(windows: readonly ChaosWindow[]) {
  const used = new Set(windows.map((window) => window.id));
  let index = windows.length + 1;
  while (used.has(`window-${index}`)) index++;

  return `window-${index}`;
}

/** Lists readable problems that would make the host reject a profile. */
export function chaosProblems(profile: ChaosProfile) {
  const result = chaosProfileSchema.safeParse(profile);
  const problems = result.success
    ? []
    : result.error.issues.map(
        (issue) => `${issue.path.join(' › ') || 'Profile'}: ${issue.message}`,
      );
  if (profile.transport.latency.p99Ms < profile.transport.latency.medianMs)
    problems.push('Request latency: p99 must not be below the median.');
  if (profile.webhooks.delay.p99Ms < profile.webhooks.delay.medianMs)
    problems.push('Webhook delay: p99 must not be below the median.');
  if (
    profile.transport.errorRate > 0 &&
    transportFaults.every((fault) => !(profile.transport.mix[fault] ?? 0))
  )
    problems.push('Fault mix: give at least one failure kind a weight.');

  return problems;
}

/** Summarizes what a profile does, in a few short lines for preset cards. */
export function describeChaos(profile: ChaosProfile) {
  const incidents = Object.values(profile.incidents).reduce<number>(
    (sum, rate) => sum + (rate ?? 0),
    0,
  );

  return [
    profile.transport.errorRate > 0
      ? `${formatPercent(profile.transport.errorRate)} of requests fail`
      : 'No transport failures',
    `Latency ${formatLatency(profile.transport.latency.medianMs)} median, ${formatLatency(profile.transport.latency.p99Ms)} p99`,
    profile.webhooks.dropRate > 0 || profile.webhooks.duplicateRate > 0
      ? `Webhooks: ${formatPercent(profile.webhooks.dropRate)} dropped, ${formatPercent(profile.webhooks.duplicateRate)} duplicated`
      : 'Webhooks delivered once, in order',
    ...profile.windows.map(
      (window) =>
        `${window.label}${window.everyMs ? ` (every ${formatDuration(window.everyMs)})` : ''}`,
    ),
    incidents > 0 ? 'Operational incidents occur' : 'No operational incidents',
  ];
}
