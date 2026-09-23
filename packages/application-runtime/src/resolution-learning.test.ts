import { isDeepStrictEqual } from 'node:util';

import { IdentityError } from '@luma/identity';
import { makeTenantContext } from '@luma/identity/composition';
import type {
  LearningEventSources,
  LearningRunSources,
  LearningStore,
} from '@luma/resolution';
import { createLearningCommands } from '@luma/resolution/composition';
import { describe, expect, it, vi } from 'vitest';

const tenantId = '11111111-1111-4111-8111-111111111111';
const incidentId = '22222222-2222-4222-8222-222222222222';
const runId = '33333333-3333-4333-8333-333333333333';
const eventId = '44444444-4444-4444-8444-444444444444';
const at = '2026-09-20T12:00:00.000Z';

function context(
  role: 'owner' | 'admin' | 'member' = 'owner',
  actor = 'operator',
  tenant = tenantId,
) {
  return makeTenantContext(
    { userId: actor, sessionId: 'session' },
    {
      id: tenant,
      name: 'Fixture',
      slug: 'fixture',
      dataRegion: 'EU',
      status: 'active',
    },
    { id: 'membership', organizationId: tenant, userId: actor, role },
    'request',
  );
}

const selection = {
  id: runId,
  diagnosisRevision: 2,
  resolution: {
    id: 'repair',
    version: '2',
    use: 'improved',
    previousVersion: '1',
    reasonCode: 'mapping',
  },
} as const;
const command = {
  id: eventId,
  occurredAt: at,
  fact: {
    kind: 'observation',
    stepId: 'repair',
    code: 'checked',
    evidenceRefs: ['evidence'],
  },
} as const;

function fixture() {
  const runSources: LearningRunSources = {
    artifactActive: true,
    previousVersionExists: true,
    binding: null,
    generation: { kind: 'manual', reference: 'author' },
    artifactDigest: 'digest',
    createdAt: at,
    diagnosis: {
      hypotheses: [],
      provenance: {
        generatedAt: at,
        engineVersion: 'diagnosis-v2',
        ruleVersion: 'rules-v1',
        configVersion: 'config-v1',
        mappingVersions: ['mapping-v1'],
        evidence: [
          {
            id: 'evidence',
            observedAt: at,
            sourceUpdatedAt: null,
            adapterVersion: 'v1',
            schemaVersion: 1,
            source: null,
          },
        ],
        validUntil: null,
        model: { status: 'disabled', model: null, promptVersion: null },
        reread: { status: 'not_requested', retryAfter: null },
      },
    },
  };
  const eventSources: LearningEventSources = {
    sequence: 1,
    recordedAt: at,
    ownedEvidenceRefs: ['evidence'],
    stepExists: true,
    verification: {
      outcome: 'passed',
      authoritative: true,
      complete: true,
      evaluatorVersion: 'v1',
      evidenceRefs: ['evidence'],
      at,
    },
    recurrenceExists: true,
  };
  // This adapter supplies retained facts and records accepted results. PostgreSQL tests
  // establish serialization, JSONB matching, rollback and tenant isolation.
  const runs = new Map<
    string,
    {
      request: unknown;
      document: Awaited<ReturnType<LearningStore['recordRun']>>;
    }
  >();
  const events = new Map<
    string,
    {
      request: unknown;
      document: Awaited<ReturnType<LearningStore['recordEvent']>>;
    }
  >();
  const store: LearningStore = {
    list: vi.fn(async () => ({ items: [], nextCursor: null })),
    read: vi.fn(async () => {
      throw new Error('History reads are outside this command fixture');
    }),
    recordRun: vi.fn(async (ctx, incident, input, accept) => {
      const key = `${ctx.tenantId}:${input.id}`;
      const request = { input, incident, actor: ctx.actor.id };
      const prior = runs.get(key);
      if (prior) {
        if (!isDeepStrictEqual(prior.request, request))
          throw new IdentityError(
            409,
            'CONFLICT',
            'Run ID already belongs to a different selection',
          );

        return structuredClone(prior.document);
      }
      const document = accept(structuredClone(runSources));
      runs.set(key, structuredClone({ request, document }));

      return document;
    }),
    recordEvent: vi.fn(async (ctx, _incident, run, input, accept) => {
      const key = `${ctx.tenantId}:${input.id}`;
      const request = { input, run, actor: ctx.actor.id };
      const prior = events.get(key);
      if (prior) {
        if (!isDeepStrictEqual(prior.request, request))
          throw new IdentityError(
            409,
            'CONFLICT',
            'Event ID already belongs to a different record',
          );

        return structuredClone(prior.document);
      }
      const document = accept(structuredClone(eventSources));
      events.set(key, structuredClone({ request, document }));
      eventSources.sequence++;

      return document;
    }),
  };
  const refreshContext = vi.fn(async (ctx: ReturnType<typeof context>) => ctx);

  return {
    service: createLearningCommands(store, refreshContext),
    store,
    runSources,
    eventSources,
    refreshContext,
    runs,
    events,
  };
}

it('captures retained diagnosis provenance and trusted attribution through the command interface', async () => {
  const { service, runSources } = fixture();
  const result = await service.start(context(), incidentId, selection);
  expect(result).toMatchObject({
    ...selection,
    incidentId,
    actorId: 'operator',
    createdAt: at,
    artifactDigest: 'digest',
    generation: runSources.generation,
    context: {
      evidenceRefs: ['evidence'],
      mappingVersions: ['mapping-v1'],
      diagnosisVersion: 'diagnosis-v2',
      model: runSources.diagnosis.provenance.model,
    },
  });
});

it('returns the recorded selection on replay after artifact revocation', async () => {
  const { service, runSources } = fixture();
  const original = await service.start(context(), incidentId, selection);
  runSources.artifactActive = false;
  expect(await service.start(context(), incidentId, selection)).toEqual(
    original,
  );
  await expect(
    service.start(context(), incidentId, { ...selection, id: eventId }),
  ).rejects.toThrow('revoked');
});

it('permits annotation of a revoked artifact only for the same admitted binding', async () => {
  const { service, runSources } = fixture();
  runSources.artifactActive = false;
  runSources.binding = {
    incidentId,
    diagnosisRevision: 2,
    artifactId: 'repair',
    artifactVersion: '2',
  };
  await expect(
    service.start(context(), incidentId, selection),
  ).resolves.toMatchObject({ id: runId });
  runSources.binding.diagnosisRevision = 3;
  await expect(
    service.start(context(), incidentId, { ...selection, id: eventId }),
  ).rejects.toThrow('binding conflicts');
});

it('rejects missing prior versions without recording a run', async () => {
  const { service, runSources, runs } = fixture();
  runSources.previousVersionExists = false;
  await expect(service.start(context(), incidentId, selection)).rejects.toThrow(
    'Previous resolution version not found',
  );
  expect(runs.size).toBe(0);
});

it.each(['tenant', 'actor', 'role'] as const)(
  'rejects fresh %s changes before touching storage',
  async (change) => {
    const { service, store, refreshContext } = fixture();
    refreshContext.mockResolvedValue(
      change === 'tenant'
        ? context('owner', 'operator', eventId)
        : change === 'actor'
          ? context('owner', 'other')
          : context('member'),
    );
    await expect(
      service.start(context(), incidentId, selection),
    ).rejects.toBeInstanceOf(IdentityError);
    await expect(
      service.append(context(), incidentId, runId, command),
    ).rejects.toBeInstanceOf(IdentityError);
    expect(store.recordRun).not.toHaveBeenCalled();
    expect(store.recordEvent).not.toHaveBeenCalled();
  },
);

it('rejects future observations and foreign evidence without consuming a sequence', async () => {
  const { service, events, eventSources } = fixture();
  await expect(
    service.append(context(), incidentId, runId, {
      ...command,
      occurredAt: '2026-09-21T00:00:00.000Z',
    }),
  ).rejects.toThrow('future');
  eventSources.ownedEvidenceRefs = [];
  await expect(
    service.append(context(), incidentId, runId, command),
  ).rejects.toThrow('belong to this incident');
  expect(events.size).toBe(0);
  eventSources.ownedEvidenceRefs = ['evidence'];
  await expect(
    service.append(context(), incidentId, runId, command),
  ).resolves.toMatchObject({
    sequence: 1,
    actorId: 'operator',
    recordedAt: at,
  });
});

it('returns the original event on replay without reevaluating changed facts', async () => {
  const { service, eventSources } = fixture();
  const original = await service.append(context(), incidentId, runId, command);
  eventSources.ownedEvidenceRefs = [];
  eventSources.stepExists = false;
  expect(await service.append(context(), incidentId, runId, command)).toEqual(
    original,
  );
  await expect(
    service.append(context(), incidentId, runId, {
      ...command,
      fact: { ...command.fact, code: 'different' },
    }),
  ).rejects.toThrow('different record');
  await expect(
    service.append(context('owner', 'other'), incidentId, runId, command),
  ).rejects.toThrow('different record');
  await expect(
    service.append(context(), incidentId, eventId, command),
  ).rejects.toThrow('different record');
});

it('requires an existing step for observations and an unused identity for repairs', async () => {
  const { service, eventSources } = fixture();
  eventSources.stepExists = false;
  await expect(
    service.append(context(), incidentId, runId, command),
  ).rejects.toThrow('Step not found');
  eventSources.stepExists = true;
  const repair = {
    ...command,
    fact: {
      kind: 'repair_step',
      stepId: 'repair',
      actionCode: 'correct',
      inputEvidenceRefs: ['evidence'],
      actionHash: 'a'.repeat(64),
      startedAt: at,
      finishedAt: at,
      effortSeconds: 0,
      result: 'accepted',
    },
  };
  await expect(
    service.append(context(), incidentId, runId, repair),
  ).rejects.toThrow('already bound');
  eventSources.stepExists = false;
  await expect(
    service.append(context(), incidentId, runId, repair),
  ).resolves.toMatchObject({ sequence: 1 });
});

const verified = {
  ...command,
  fact: {
    kind: 'outcome',
    result: 'verified',
    authoritative: true,
    complete: true,
    evaluatorVersion: 'v1',
    evidenceRefs: ['evidence'],
    businessResult: { code: 'corrected', value: null, unit: null },
  },
};

describe('canonical verification acceptance', () => {
  it.each([
    null,
    { outcome: 'failed' },
    { authoritative: false },
    { complete: false },
    { evaluatorVersion: 'other' },
    { evidenceRefs: ['other'] },
    { at: '2026-09-21T00:00:00.000Z' },
  ] as const)('rejects mismatched verification %j', async (patch) => {
    const { service, eventSources, events } = fixture();
    eventSources.verification =
      patch === null
        ? null
        : {
            ...eventSources.verification!,
            ...patch,
            evidenceRefs:
              'evidenceRefs' in patch ? [...patch.evidenceRefs] : ['evidence'],
          };
    await expect(
      service.append(context(), incidentId, runId, verified),
    ).rejects.toThrow('authoritative verification');
    expect(events.size).toBe(0);
  });
  it('records verified outcomes only against matching canonical verification', async () => {
    const { service } = fixture();
    await expect(
      service.append(context(), incidentId, runId, verified),
    ).resolves.toMatchObject({ fact: verified.fact, sequence: 1 });
  });
});

it('requires the canonical recurrence link', async () => {
  const { service, eventSources } = fixture();
  eventSources.recurrenceExists = false;
  const recurrence = {
    ...command,
    fact: {
      kind: 'recurrence',
      incidentId: eventId,
      evidenceRefs: ['evidence'],
    },
  };
  await expect(
    service.append(context(), incidentId, runId, recurrence),
  ).rejects.toThrow('recorded recurrence');
  eventSources.recurrenceExists = true;
  await expect(
    service.append(context(), incidentId, runId, recurrence),
  ).resolves.toMatchObject({ sequence: 1 });
});

it('uses production validation for model assertions, repair chronology and selection requirements', async () => {
  const { service, store } = fixture();
  await expect(
    service.start(context(), incidentId, {
      ...selection,
      resolution: { ...selection.resolution, previousVersion: '2' },
    }),
  ).rejects.toThrow();
  await expect(
    service.append(context(), incidentId, runId, {
      ...command,
      fact: {
        kind: 'cause',
        code: 'cause',
        status: 'confirmed',
        basis: 'model_hypothesis',
        supportingEvidenceRefs: ['evidence'],
        contradictingEvidenceRefs: [],
      },
    }),
  ).rejects.toThrow('Model hypotheses remain suspected');
  await expect(
    service.append(context(), incidentId, runId, {
      ...command,
      fact: {
        kind: 'repair_step',
        stepId: 'new',
        actionCode: 'correct',
        inputEvidenceRefs: ['evidence'],
        actionHash: 'a'.repeat(64),
        startedAt: at,
        finishedAt: at,
        effortSeconds: 10,
        result: 'accepted',
      },
    }),
  ).rejects.toThrow('Repair times or effort are inconsistent');
  expect(store.recordRun).not.toHaveBeenCalled();
  expect(store.recordEvent).not.toHaveBeenCalled();
});
