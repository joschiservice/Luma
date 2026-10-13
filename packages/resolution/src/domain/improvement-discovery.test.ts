import { expect, it } from 'vitest';

import {
  discoverImprovements,
  type ImprovementDiscoverySource,
} from './improvement-discovery.js';

const asOf = '2026-09-30T12:00:00.000Z';

function source(id: string, synthetic = false): ImprovementDiscoverySource {
  return {
    measurement: {
      id,
      title: 'inventory_mismatch',
      state: 'resolved',
      detectedAt: '2026-09-30T10:00:00.000Z',
      previousIncidentId: null,
      synthetic,
      humanEvidence: [],
      resolution: {
        kind: 'verification',
        outcome: 'passed',
        authoritative: true,
        complete: true,
        evidenceRefs: ['read'],
        at: '2026-09-30T11:00:00.000Z',
      },
      events: [
        {
          id: 'environment',
          incidentId: id,
          revision: 1,
          schemaVersion: 1,
          actorId: 'operator',
          recordedAt: asOf,
          fact: {
            kind: 'environment',
            environment: 'live',
            evidenceRefs: ['read'],
          },
        },
      ],
    },
    runId: `run-${id}`,
    subjectId: `subject-${id}`,
    artifact: { id: 'repair', version: '1', digest: 'hash' },
    humanInterventions: 1,
    humanEdits: 0,
    effortSeconds: null,
    recurrences: 0,
  };
}

it('deduplicates incidents, separates synthetic cohorts and exposes no promotion authority', () => {
  const real = [source('a'), source('b'), source('c')];
  const groups = discoverImprovements(
    [...real, source('a'), source('synthetic', true)],
    asOf,
    JSON.stringify,
  );
  const live = groups.find((group) => group.environment === 'live');
  expect(live).toMatchObject({
    verifiedIncidents: 3,
    humanInterventions: 3,
    eligibleForProposal: true,
    recordedEffortSeconds: null,
    productionPromotion: 'blocked',
  });
  expect(live?.missingEvidence).toContain('trusted_historical_replay');
  expect(
    groups.find((group) => group.environment === 'synthetic'),
  ).toMatchObject({
    verifiedIncidents: 1,
    eligibleForProposal: false,
    productionPromotion: 'blocked',
  });
});
it('does not infer verification or live environment from accepted actions or missing facts', () => {
  const unknown = source('unknown');
  unknown.measurement.events = [];
  const failed = source('failed');
  failed.measurement.resolution = null;
  const observe = source('observe');
  observe.measurement.observeOnly = true;
  const groups = discoverImprovements(
    [unknown, failed, observe],
    asOf,
    JSON.stringify,
  );
  expect(groups).toHaveLength(1);
  expect(groups[0]).toMatchObject({
    environment: 'unknown',
    eligibleForProposal: false,
  });
  expect(groups[0]?.missingEvidence).toContain('real_run_volume');
});
