import {
  builtInMembership,
  IdentityError,
  makeTenantContext,
} from '@luma/identity';
import type { LearningService } from '@luma/resolution';
import { expect, it, vi } from 'vitest';

import { createWorkflowImprovementSource } from './workflow-improvements.js';

const context = makeTenantContext(
  { userId: 'operator', sessionId: 'session' },
  {
    id: 'tenant',
    name: 'Tenant',
    slug: 'tenant',
    dataRegion: 'AU',
    status: 'active',
  },
  builtInMembership(
    { id: 'member', organizationId: 'tenant', userId: 'operator' },
    'admin',
  ),
  'request',
);
const source = { incidentId: 'incident', runId: 'run' };

function history(): Awaited<ReturnType<LearningService['read']>> {
  return {
    run: {
      id: 'run',
      schemaVersion: 1,
      incidentId: 'incident',
      actorId: 'operator',
      diagnosisRevision: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      resolution: {
        id: 'repair',
        version: '1.0.0',
        use: 'reused',
        reasonCode: 'stock-correction',
      },
      context: {
        evidenceRefs: ['initial-read'],
        mappingVersions: ['1'],
        configVersion: '1',
        ruleVersion: '1',
        diagnosisVersion: '1',
        hypotheses: [],
        model: { status: 'disabled', model: null, promptVersion: null },
      },
      generation: { kind: 'manual', reference: 'review' },
      artifactDigest: 'a'.repeat(64),
    },
    events: [
      {
        id: 'outcome',
        occurredAt: '2026-01-01T01:00:00.000Z',
        recordedAt: '2026-01-01T01:00:00.000Z',
        actorId: 'operator',
        sequence: 1,
        fact: {
          kind: 'outcome',
          result: 'verified',
          authoritative: true,
          complete: true,
          evidenceRefs: ['verified-read'],
          evaluatorVersion: 'inventory/1',
          businessResult: { code: 'stock-agrees', value: null, unit: null },
        },
      },
    ],
    steps: [],
    executions: [],
    verifications: [],
    failures: [],
    incidentVerifications: [],
    recurrences: [],
    incident: {
      id: 'incident',
      tenantId: 'tenant',
      fingerprint: 'fingerprint',
      exceptionClass: 'inventory_mismatch',
      subject: {
        ruleIdentity: 'available-stock',
        subjectKind: 'sku',
        subjectId: 'stock',
        scope: ['location'],
      },
      severity: 'medium',
      state: 'resolved',
      firstDetectedAt: '2026-01-01T00:00:00.000Z',
      lastDetectedAt: '2026-01-01T00:00:00.000Z',
      occurrenceCount: 1,
      previousExceptionId: null,
      ruleVersion: '1',
      configVersion: '1',
      resolution: {
        kind: 'verification',
        reason: 'stock-agrees',
        fingerprint: 'fingerprint',
        configVersion: '1',
        evaluatorVersion: 'inventory/1',
        outcome: 'passed',
        complete: true,
        authoritative: true,
        evidenceRefs: ['verified-read'],
        evidence: [],
        bindings: [],
        incidentVersion: 1,
        actorId: 'operator',
        auditId: 'audit',
        at: '2026-01-01T01:00:00.000Z',
      },
    },
  };
}

it('exposes only authorized structured verified facts, preserves source provenance and supports both patterns', async () => {
  const stored = history();
  const read = vi.fn<LearningService['read']>().mockResolvedValue(stored);
  const adapter = createWorkflowImprovementSource(
    { read },
    async (_tenant, flag) => flag === 'workflow-improvements',
  );
  expect(await adapter.enabled(context)).toBe(true);
  const evidence = await adapter.evidence(context, source);
  expect(read).toHaveBeenCalledWith(context, 'incident', 'run');
  expect(evidence.subjectId).toBe('stock');
  expect(evidence.evidenceRefs).toEqual(['initial-read', 'verified-read']);
  expect(evidence).not.toHaveProperty('hypotheses');
  stored.incident.exceptionClass = 'sync_failure';
  expect((await adapter.evidence(context, source)).pattern).toBe(
    'sync_failure',
  );
});

it('rejects cross-tenant, unverified, unsupported and claimed-only resolutions, and propagates access loss', async () => {
  const read = vi.fn<LearningService['read']>();
  const adapter = createWorkflowImprovementSource({ read }, async () => false);
  const foreign = history();
  foreign.incident.tenantId = 'other';
  read.mockResolvedValue(foreign);
  await expect(adapter.evidence(context, source)).rejects.toMatchObject({
    statusCode: 404,
  });
  const incomplete = history();
  if (incomplete.incident.resolution?.kind === 'verification')
    incomplete.incident.resolution.complete = false;
  read.mockResolvedValue(incomplete);
  await expect(adapter.evidence(context, source)).rejects.toMatchObject({
    statusCode: 409,
  });
  const unsupported = history();
  unsupported.incident.exceptionClass = 'stuck_fulfillment';
  read.mockResolvedValue(unsupported);
  await expect(adapter.evidence(context, source)).rejects.toMatchObject({
    statusCode: 409,
  });
  const claimed = history();
  claimed.events = [];
  read.mockResolvedValue(claimed);
  await expect(adapter.evidence(context, source)).rejects.toMatchObject({
    statusCode: 409,
  });
  read.mockRejectedValue(
    new IdentityError(403, 'FORBIDDEN', 'Access changed.'),
  );
  await expect(adapter.evidence(context, source)).rejects.toMatchObject({
    statusCode: 403,
  });
});
