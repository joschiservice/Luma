import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { evaluate } from '../domain/evaluate.js';
import { defaultConfiguration } from '../domain/facts.js';
import { parseInput } from './validation.js';

const corpus = JSON.parse(
  readFileSync(
    new URL('../../fixtures/exceptions-v0.json', import.meta.url),
    'utf8',
  ),
);
const facts = {
  ...corpus.bases.inventory_mismatch,
  leftAvailable: '100',
  rightAvailable: '101',
  mismatchSince: '2026-09-17T11:57:59Z',
};
const verdict = (
  changes: Record<string, unknown> = {},
  thresholds = defaultConfiguration.thresholds,
) =>
  evaluate(
    parseInput('inventory_mismatch', { ...facts, ...changes }),
    corpus.now,
    thresholds,
  );

describe('directional stock confirmation', () => {
  it('raises a small oversell gap after two minutes but lets understatement wait thirty minutes', () => {
    expect(verdict()).toMatchObject({
      decision: 'detect',
      severity: 'high',
      reason: 'oversell_risk',
    });
    expect(verdict({ rightAvailable: '99' })).toMatchObject({
      decision: 'defer',
      reason: 'propagation_pending',
    });
  });
  it('keeps the boundary tentative and honors workspace windows and tolerance', () => {
    expect(verdict({ mismatchSince: '2026-09-17T11:58:00Z' })).toMatchObject({
      decision: 'defer',
    });
    expect(
      verdict(
        {},
        { ...defaultConfiguration.thresholds, oversellPropagationSeconds: 300 },
      ),
    ).toMatchObject({ decision: 'defer' });
    expect(verdict({ tolerance: '1' })).toMatchObject({ decision: 'clear' });
    expect(
      verdict(
        { mismatchSince: '2026-09-17T11:59:59Z' },
        { ...defaultConfiguration.thresholds, oversellPropagationSeconds: 0 },
      ),
    ).toMatchObject({ decision: 'detect' });
  });
  it('does not authorize detection from stale, incomplete or unknown-authority evidence', () => {
    expect(verdict({ rightObservedAt: '2026-09-17T11:50:00Z' })).toMatchObject({
      decision: 'defer',
    });
    expect(verdict({ complete: false })).toMatchObject({ decision: 'defer' });
    expect(verdict({ authorityState: 'unknown' })).toMatchObject({
      decision: 'defer',
    });
  });
});
