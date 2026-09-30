import { describe, expect, it } from 'vitest';

import type {
  MeasurementEvent,
  MeasurementFact,
  MeasurementSource,
} from './measurement.js';
import {
  classifyResolution,
  summarizeResolutionMetrics,
} from './measurement.js';

const asOf = '2026-09-30T12:00:00.000Z';
const detectedAt = '2026-09-30T10:00:00.000Z';
const verifiedAt = '2026-09-30T11:00:00.000Z';
const event = (fact: MeasurementFact, revision: number): MeasurementEvent => ({
  id: `fact-${revision}`,
  incidentId: 'incident',
  revision,
  schemaVersion: 1,
  actorId: 'operator',
  recordedAt: verifiedAt,
  fact,
});

function source(patch: Partial<MeasurementSource> = {}): MeasurementSource {
  return {
    id: 'incident',
    title: 'inventory_mismatch',
    state: 'resolved',
    detectedAt,
    previousIncidentId: null,
    synthetic: false,
    humanEvidence: [],
    resolution: {
      kind: 'verification',
      at: verifiedAt,
      outcome: 'passed',
      authoritative: true,
      complete: true,
      evidenceRefs: ['fresh-read'],
    },
    events: [
      event(
        { kind: 'environment', environment: 'live', evidenceRefs: ['read'] },
        1,
      ),
      event(
        {
          kind: 'eligibility',
          status: 'eligible',
          ruleVersion: 'rule/1',
          reasonCode: 'supported',
          evidenceRefs: ['read'],
        },
        2,
      ),
      event(
        {
          kind: 'attribution',
          involvement: 'none',
          complete: true,
          from: detectedAt,
          through: verifiedAt,
          evidenceRefs: ['audit'],
        },
        3,
      ),
    ],
    ...patch,
  };
}

const metric = (sources: MeasurementSource[], id: string) =>
  summarizeResolutionMetrics(sources, asOf).find(
    (m) => m.definition.id === `resolution.${id}`,
  )!;

it('counts incident IDs independently of attempts and reconciles every count with its cohort', () => {
  const input = source({
    humanEvidence: ['approval:a', 'approval:b', 'repair:a'],
  });
  const results = summarizeResolutionMetrics([input], asOf);
  for (const result of results.filter((r) => r.definition.unit === 'case'))
    expect(result.value).toBe(result.items.length);
  expect(metric([input], 'verified').value).toBe(1);
  expect(metric([input], 'human').value).toBe(1);
  expect(metric([input], 'autonomous').value).toBe(0);
});

it.each(['approval', 'manual_repair', 'operator_correction'] as const)(
  'never clears a retained %s with a later absence assertion',
  (involvement) => {
    const input = source();
    input.events.push(
      event(
        {
          kind: 'attribution',
          involvement,
          complete: false,
          from: detectedAt,
          through: verifiedAt,
          evidenceRefs: ['human'],
        },
        4,
      ),
      event(
        {
          kind: 'attribution',
          involvement: 'none',
          complete: true,
          from: detectedAt,
          through: verifiedAt,
          evidenceRefs: ['audit'],
        },
        5,
      ),
    );
    expect(classifyResolution(input, asOf).involvement).toBe('human');
    expect(metric([input], 'autonomous').value).toBe(0);
  },
);

it('keeps missing eligibility and attribution unknown rather than zero', () => {
  const input = source({
    events: [
      event(
        { kind: 'environment', environment: 'live', evidenceRefs: ['read'] },
        1,
      ),
    ],
  });
  expect(classifyResolution(input, asOf)).toMatchObject({
    eligibility: 'unknown',
    involvement: 'unknown',
    outcome: 'verified',
  });
  expect(metric([input], 'autonomous')).toMatchObject({
    value: 0,
    total: null,
    unknownCount: 1,
    coverage: 'partial',
  });
  expect(metric([input], 'unknown_eligibility').items.map((i) => i.id)).toEqual(
    ['incident'],
  );
});

it('retains complete attribution only through the currently verified outcome', () => {
  expect(classifyResolution(source(), asOf).involvement).toBe('none');
  const reopened = source({ state: 'verifying' });
  expect(classifyResolution(reopened, asOf)).toMatchObject({
    outcome: 'pending',
    involvement: 'unknown',
    verifiedAt: null,
    unresolvedAgeSeconds: 7200,
  });
  const reverified = source({
    resolution: { ...source().resolution!, at: asOf },
  });
  expect(classifyResolution(reverified, asOf).involvement).toBe('unknown');
});

it.each([
  { authoritative: false },
  { complete: false },
  { outcome: 'failed' },
  { evidenceRefs: [] },
  { at: '2026-09-30T13:00:00.000Z' },
])('requires independently retained canonical verification %j', (patch) => {
  expect(
    classifyResolution(
      source({ resolution: { ...source().resolution!, ...patch } }),
      asOf,
    ).outcome,
  ).toBe('pending');
});

it('keeps synthetic and unclassified incidents out of live cohorts', () => {
  const synthetic = source({ id: 'synthetic', synthetic: true });
  const unknown = source({ id: 'unknown', events: [] });
  const results = summarizeResolutionMetrics(
    [source(), synthetic, unknown],
    asOf,
  );
  expect(
    results.find((r) => r.definition.id === 'resolution.verified'),
  ).toMatchObject({
    value: 1,
    population: 1,
    total: null,
    coverage: 'partial',
  });
  expect(
    summarizeResolutionMetrics([synthetic], asOf, {
      environment: 'synthetic',
    })[0]!.population,
  ).toBe(1);
  expect(
    summarizeResolutionMetrics([unknown], asOf, { environment: 'unknown' })[0]!
      .population,
  ).toBe(1);
});

it('assigns detection cohorts at half-open boundaries and leaves late outcomes in their original cohort', () => {
  const atStart = source({
    id: 'start',
    detectedAt: '2026-09-29T12:00:00.000Z',
  });
  const before = source({
    id: 'before',
    detectedAt: '2026-09-29T11:59:59.999Z',
  });
  const atEnd = source({ id: 'end', detectedAt: asOf });
  const value = summarizeResolutionMetrics([atStart, before, atEnd], asOf, {
    window: '24h',
  }).find((m) => m.definition.id === 'resolution.verified')!;
  expect(value.items.map((i) => i.id)).toEqual(['start']);
  expect(value.value).toBe(1);
});

it('reports durations, recurrence and evidenced incorrect actions without promoting failures to incorrectness', () => {
  const input = source({ previousIncidentId: 'previous' });
  input.events.push(
    event(
      {
        kind: 'incorrect_action',
        proposalId: 'proposal',
        reasonCode: 'wrong_target',
        evidenceRefs: ['read'],
      },
      4,
    ),
  );
  expect(metric([input], 'recurrent').value).toBe(1);
  expect(metric([input], 'incorrect_actions').value).toBe(1);
  expect(metric([input], 'autonomous').value).toBe(0);
  expect(metric([input], 'time_to_outcome').value).toBe(3600);
  expect(
    metric([source({ state: 'failed', resolution: null })], 'incorrect_actions')
      .value,
  ).toBe(0);
});

it('distinguishes empty population, known zero matches and unknown provider data-through time', () => {
  expect(metric([], 'eligible')).toMatchObject({
    population: 0,
    coverage: 'unavailable',
    dataThrough: null,
  });
  const input = source();
  input.events.push(
    event(
      {
        kind: 'eligibility',
        status: 'ineligible',
        ruleVersion: 'rule/2',
        reasonCode: 'unsupported',
        evidenceRefs: ['read'],
      },
      4,
    ),
  );
  expect(metric([input], 'eligible')).toMatchObject({
    value: 0,
    total: 0,
    population: 1,
    coverage: 'complete',
  });
  expect(metric([input], 'autonomous').items).toEqual([]);
});

describe('duration aggregation', () => {
  it('uses every verified incident for the median and retains the oldest pending incident', () => {
    const inputs = [
      source(),
      source({
        id: 'second',
        resolution: { ...source().resolution!, at: '2026-09-30T10:30:00.000Z' },
      }),
      source({ id: 'pending', state: 'verifying', resolution: null }),
    ];
    expect(metric(inputs, 'time_to_outcome').value).toBe(2700);
    expect(metric(inputs, 'time_to_outcome').items).toHaveLength(2);
    expect(metric(inputs, 'unresolved_age').value).toBe(7200);
  });
});
