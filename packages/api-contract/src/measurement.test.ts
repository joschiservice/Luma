import { expect, it } from 'vitest';

import { measurementCommandSchema } from './measurement.js';
import { operationalMetricRequestSchema } from './operational-metrics.js';

const command = {
  id: '00000000-0000-4000-8000-000000000001',
  expectedRevision: 0,
  fact: {
    kind: 'attribution',
    involvement: 'none',
    complete: true,
    from: '2026-09-30T00:00:00Z',
    through: '2026-09-30T01:00:00Z',
    evidenceRefs: ['owned'],
  },
};
it('rejects incomplete absence claims, reversed intervals, missing evidence and unversioned corrections', () => {
  expect(measurementCommandSchema.safeParse(command).success).toBe(true);
  for (const fact of [
    { ...command.fact, complete: false },
    { ...command.fact, from: '2026-09-30T02:00:00Z' },
    { ...command.fact, evidenceRefs: [] },
    { ...command.fact, actorId: 'untrusted' },
  ])
    expect(
      measurementCommandSchema.safeParse({ ...command, fact }).success,
    ).toBe(false);
  expect(
    measurementCommandSchema.safeParse({ ...command, expectedRevision: -1 })
      .success,
  ).toBe(false);
});
it('retains measured partner sample provenance and rejects impossible sample durations', () => {
  const fact = {
    kind: 'baseline',
    partnerReference: 'partner-1',
    processVersion: 'manual-v1',
    sampleSize: 10,
    measuredSeconds: 600,
    from: '2026-09-30T00:00:00Z',
    through: '2026-09-30T01:00:00Z',
    evidenceRefs: ['sample'],
  };
  expect(measurementCommandSchema.parse({ ...command, fact }).fact).toEqual(
    fact,
  );
  for (const patch of [
    { sampleSize: 0 },
    { measuredSeconds: 0 },
    { measuredSeconds: 3601 },
    { processVersion: '' },
  ])
    expect(
      measurementCommandSchema.safeParse({
        ...command,
        fact: { ...fact, ...patch },
      }).success,
    ).toBe(false);
});
it('accepts the shared resolution family and rejects filters unsupported by any selected metric', () => {
  const request = {
    definitionVersion: 2,
    metrics: ['resolution.autonomous', 'resolution.unknown_eligibility'],
    scope: { environment: 'live', window: '24h' },
  };
  expect(operationalMetricRequestSchema.safeParse(request).success).toBe(true);
  expect(
    operationalMetricRequestSchema.safeParse({
      ...request,
      metrics: ['resolution.autonomous', 'cases.active'],
    }).success,
  ).toBe(false);
  expect(
    operationalMetricRequestSchema.safeParse({
      ...request,
      scope: { connectionId: command.id },
    }).success,
  ).toBe(false);
});
