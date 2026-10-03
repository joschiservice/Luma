import { describe, expect, it } from 'vitest';

import {
  describeOffset,
  formatDuration,
  formatLatency,
  formatPercent,
  fromLocalInput,
  fromPercent,
  progressText,
  runStatusText,
  speedLabel,
  summarizeJson,
  toLocalInput,
  toPercent,
} from './format';

describe('formatDuration', () => {
  it('uses the two largest units and drops empty trailing ones', () => {
    expect(formatDuration(450)).toBe('450 ms');
    expect(formatDuration(45_000)).toBe('45 s');
    expect(formatDuration(3_900_000)).toBe('1 h 5 min');
    expect(formatDuration(3_600_000 + 30_000)).toBe('1 h');
    expect(formatDuration(2 * 86_400_000 + 3 * 3_600_000 + 60_000)).toBe(
      '2 d 3 h',
    );
  });

  it('describes negative durations by their size', () => {
    expect(formatDuration(-300_000)).toBe('5 min');
  });
});

describe('describeOffset', () => {
  it('treats small drift as real time', () => {
    expect(describeOffset(1_500)).toEqual({
      state: 'real-time',
      text: 'Real time',
    });
  });

  it('names how far ahead or behind the simulation is', () => {
    expect(describeOffset(3_900_000)).toEqual({
      state: 'ahead',
      text: 'Ahead of real time by 1 h 5 min',
    });
    expect(describeOffset(-60_000).text).toBe('Behind real time by 1 min');
  });
});

describe('labels', () => {
  it('names clock speeds', () => {
    expect(speedLabel(1)).toBe('Real time');
    expect(speedLabel(10)).toBe('Fast-forward 10×');
  });

  it('formats rates and latency', () => {
    expect(formatPercent(0.015)).toBe('1.5%');
    expect(formatPercent(0.12345, 2)).toBe('12.35%');
    expect(formatLatency(120)).toBe('120 ms');
    expect(formatLatency(1_500)).toBe('1.5 s');
  });

  it('round-trips percentages without float noise', () => {
    expect(toPercent(0.015)).toBe(1.5);
    expect(toPercent(0.07)).toBe(7);
    expect(fromPercent(1.5)).toBe(0.015);
  });

  it('describes provisioning progress', () => {
    const progress = {
      step: 'generating catalog',
      done: 12_000,
      total: 40_000,
    };
    expect(progressText(progress)).toBe('Generating catalog: 12,000 / 40,000');
    expect(runStatusText({ status: 'provisioning', progress })).toBe(
      'Provisioning 12,000 / 40,000',
    );
    expect(runStatusText({ status: 'ready', progress: null })).toBe('Ready');
  });

  it('shortens long JSON', () => {
    expect(summarizeJson({ a: 'x'.repeat(50) }, 20)).toHaveLength(20);
    expect(summarizeJson(undefined)).toBe('undefined');
  });
});

describe('local date inputs', () => {
  it('round-trips minutes in the local zone', () => {
    const instant = new Date(2026, 9, 3, 14, 5).getTime();
    expect(fromLocalInput(toLocalInput(instant))).toBe(instant);
    expect(fromLocalInput('')).toBeNull();
  });
});
