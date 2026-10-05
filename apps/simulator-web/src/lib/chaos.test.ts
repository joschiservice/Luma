import { chaosPreset } from '@luma/simulator-core';
import { describe, expect, it } from 'vitest';

import {
  chaosProblems,
  chaosReducer,
  customPreset,
  describeChaos,
  nextWindowId,
} from './chaos';

const realistic = chaosPreset('realistic');
const loaded = chaosReducer(
  { profile: realistic, dirty: true },
  { type: 'load', profile: realistic },
);

describe('chaosReducer', () => {
  it('loads the applied profile as a clean copy', () => {
    expect(loaded.dirty).toBe(false);
    expect(loaded.profile).toEqual(realistic);
    expect(loaded.profile).not.toBe(realistic);
  });

  it('marks edits custom without changing the input', () => {
    const edited = chaosReducer(loaded, {
      type: 'transport',
      field: 'errorRate',
      value: 0.1,
    });
    expect(edited.dirty).toBe(true);
    expect(edited.profile.preset).toBe(customPreset);
    expect(edited.profile.transport.errorRate).toBe(0.1);
    expect(loaded.profile.transport.errorRate).toBe(0.003);
  });

  it('starts from a preset with its name', () => {
    const preset = chaosReducer(loaded, {
      type: 'preset',
      profile: chaosPreset('calm'),
    });
    expect(preset).toMatchObject({ dirty: true, profile: { preset: 'calm' } });
  });

  it('edits nested values', () => {
    let draft = chaosReducer(loaded, {
      type: 'mix',
      fault: 'timeout',
      value: 50,
    });
    draft = chaosReducer(draft, {
      type: 'latency',
      target: 'webhooks',
      field: 'p99Ms',
      value: 60_000,
    });
    draft = chaosReducer(draft, {
      type: 'incident',
      kind: 'oversell',
      value: 2,
    });
    expect(draft.profile.transport.mix.timeout).toBe(50);
    expect(draft.profile.transport.mix.unavailable).toBe(30);
    expect(draft.profile.webhooks.delay).toEqual({
      medianMs: 1_500,
      p99Ms: 60_000,
    });
    expect(draft.profile.incidents.oversell).toBe(2);
  });

  it('adds, updates and removes windows and overrides by position', () => {
    const window = {
      id: 'window-1',
      label: 'Outage',
      startsAt: 0,
      durationMs: 60_000,
      errorRate: 1,
    };
    let draft = chaosReducer(loaded, { type: 'add-window', window });
    draft = chaosReducer(draft, {
      type: 'update-window',
      index: 0,
      window: { ...window, label: 'Night outage' },
    });
    expect(draft.profile.windows).toEqual([
      { ...window, label: 'Night outage' },
    ]);
    const overrides = loaded.profile.overrides;
    draft = chaosReducer(draft, {
      type: 'add-override',
      override: { instance: 'shopify-de' },
    });
    expect(draft.profile.overrides).toEqual([
      ...overrides,
      { instance: 'shopify-de' },
    ]);
    draft = chaosReducer(draft, { type: 'remove-window', index: 0 });
    draft = chaosReducer(draft, {
      type: 'remove-override',
      index: overrides.length,
    });
    expect(draft.profile.windows).toEqual([]);
    expect(draft.profile.overrides).toEqual(overrides);
  });
});

describe('chaosProblems', () => {
  it('accepts the presets', () => {
    expect(chaosProblems(realistic)).toEqual([]);
  });

  it('reports values the host would reject or that make no sense', () => {
    const problems = chaosProblems({
      ...realistic,
      transport: {
        ...realistic.transport,
        errorRate: 1.5,
        latency: { medianMs: 500, p99Ms: 100 },
      },
      windows: [
        {
          id: 'Bad ID',
          label: 'x',
          startsAt: 0,
          durationMs: 60_000,
          errorRate: 0,
        },
      ],
    });
    expect(problems.some((p) => p.startsWith('transport › errorRate'))).toBe(
      true,
    );
    expect(problems.some((p) => p.startsWith('windows › 0 › id'))).toBe(true);
    expect(problems).toContain(
      'Request latency: p99 must not be below the median.',
    );
  });

  it('requires a failure mix when requests fail', () => {
    const mix = Object.fromEntries(
      Object.keys(realistic.transport.mix).map((fault) => [fault, 0]),
    );
    expect(
      chaosProblems({
        ...realistic,
        transport: { ...realistic.transport, mix },
      }),
    ).toContain('Fault mix: give at least one failure kind a weight.');
  });
});

describe('helpers', () => {
  it('chooses unused window IDs', () => {
    const base = { label: 'x', startsAt: 0, durationMs: 60_000, errorRate: 0 };
    expect(nextWindowId([])).toBe('window-1');
    expect(
      nextWindowId([
        { ...base, id: 'window-2' },
        { ...base, id: 'window-3' },
      ]),
    ).toBe('window-4');
  });

  it('summarizes presets', () => {
    expect(describeChaos(chaosPreset('calm'))).toEqual([
      'No transport failures',
      'Latency 5 ms median, 30 ms p99',
      'Webhooks delivered once, in order',
      'No operational incidents',
    ]);
    expect(describeChaos(chaosPreset('outage-drill'))).toContain(
      'All providers unavailable for 10 minutes every hour (every 1 h)',
    );
  });
});
