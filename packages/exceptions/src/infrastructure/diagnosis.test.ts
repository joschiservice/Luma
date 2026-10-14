import { readFileSync } from 'node:fs';

import { builtInMembership, makeTenantContext } from '@luma/identity';
import { describe, expect, it, vi } from 'vitest';

import { createDiagnosisService } from '../application/diagnosis.js';
import type { DiagnosisInput } from '../domain/diagnosis.js';
import { diagnose } from '../domain/diagnosis.js';
import { identity } from '../domain/evaluate.js';
import type { ExceptionClass } from '../domain/facts.js';
import { defaultConfiguration } from '../domain/facts.js';
import { boundedInvestigation, selectionSchema } from './diagnosis-boundary.js';
import { parseInput } from './validation.js';

const corpus = JSON.parse(
  readFileSync(
    new URL('../../fixtures/exceptions-v0.json', import.meta.url),
    'utf8',
  ),
);

function snapshot(
  exceptionClass: ExceptionClass,
  changes: Record<string, unknown> = {},
): DiagnosisInput {
  const input = parseInput(exceptionClass, {
    ...corpus.bases[exceptionClass],
    ...changes,
  });
  const subject = identity(input);

  return {
    exceptionId: '11111111-1111-4111-8111-111111111111',
    revision: 1,
    firstDetectedAt: corpus.now,
    reviewRequired: false,
    subject: {
      kind: subject.subjectKind,
      id: subject.subjectId,
      scope: subject.scope,
    },
    input,
    configuration: {
      ...defaultConfiguration,
      inventoryTolerance:
        input.exceptionClass === 'inventory_mismatch'
          ? input.facts.tolerance
          : '0',
    },
    evidence: input.facts.evidenceRefs.map((key) => ({
      key,
      tenantId: input.facts.tenantId,
      connectionId: null,
      observedAt: corpus.now,
      sourceUpdatedAt: null,
      adapterVersion: 'fixture',
      schemaVersion: 1,
      source: null,
      facts: {},
    })),
  };
}

describe('deterministic evidence-grounded diagnoses', () => {
  it('records independently tested hypothesis contradictions while preserving missing causal checks', () => {
    const value = snapshot('inventory_mismatch', {
      leftAvailable: '4',
      rightAvailable: '12',
      authority: 'left',
      sellingSource: 'right',
    });
    const refs = [...value.input.facts.evidenceRefs];
    const marker = {
      ...value.evidence[0]!,
      key: 'investigation:trusted',
      adapterVersion: 'diagnosis-investigation-v1',
      facts: {
        incidentId: value.exceptionId,
        complete: true,
        calls: 2,
        supportingEvidenceRefs: refs,
      },
    };
    value.evidence.push(marker);
    value.input.facts.evidenceRefs.push(marker.key);
    const result = diagnose(value, corpus.now);
    expect(result.facts.map((finding) => finding.code)).toContain(
      'transient_snapshots_hypothesis_contradicted',
    );
    expect(
      result.facts.find(
        (finding) =>
          finding.code === 'transient_snapshots_hypothesis_contradicted',
      )?.evidenceRefs,
    ).toEqual(refs);
    expect(
      result.hypotheses.every(
        (hypothesis) =>
          hypothesis.uncertainty === 'unsubstantiated' &&
          hypothesis.missingChecks.length > 0,
      ),
    ).toBe(true);
    expect(
      result.nextSteps.some((step) => step.kind === 'manual_intervention'),
    ).toBe(true);
    marker.connectionId = value.input.facts.tenantId;
    expect(
      diagnose(value, corpus.now).facts.map((finding) => finding.code),
    ).not.toContain('scoped_investigation_complete');
  });
  for (const test of corpus.cases as {
    id: string;
    exceptionClass: ExceptionClass;
    input: Record<string, unknown>;
    expected: { decision: string };
  }[]) {
    it(test.id, () => {
      const value = snapshot(test.exceptionClass, test.input);
      if (test.expected.decision === 'reject') {
        expect(() => diagnose(value, corpus.now)).toThrow('scope');

        return;
      }
      const result = diagnose(value, corpus.now);
      expect(result).toEqual(diagnose(value, corpus.now));
      expect(result.detectorDecision).toEqual(test.expected);
      expect(result.status).toBe(
        test.expected.decision === 'defer' ? 'insufficient_evidence' : 'ready',
      );
      expect(result.impact.cost).toBeNull();
      if (test.expected.decision !== 'detect') {
        expect(result.hypotheses).toEqual([]);
        expect(
          result.nextSteps.some(
            (step) => step.code === 'manual_inventory_review',
          ),
        ).toBe(false);
      }
      for (const fact of [...result.facts, ...result.hypotheses])
        expect(
          fact.evidenceRefs.every((ref) =>
            value.input.facts.evidenceRefs.includes(ref),
          ),
        ).toBe(true);
    });
  }
  it('explains the representative Shopify 12 / JTL 4 exposure without inventing loss', () => {
    const result = diagnose(
      snapshot('inventory_mismatch', {
        leftAvailable: '4',
        rightAvailable: '12',
        authority: 'left',
        sellingSource: 'right',
      }),
      corpus.now,
    );
    expect(result.impact.exposedQuantity).toBe('8.000000');
    expect(result.impact.potential[0]?.code).toBe('oversell_exposure');
    expect(result.nextSteps.map((s) => s.code)).toContain(
      'manual_inventory_review',
    );
    expect(result.attention.suggested).toBe(true);
    expect(
      result.hypotheses.every((h) => h.uncertainty === 'unsubstantiated'),
    ).toBe(true);
  });
  it.each([
    {
      changes: { mismatchSince: '2026-09-17T11:20:00Z' },
      code: 'sync_did_not_close_gap',
      text: 'Luma first saw this gap at 2026-09-17T11:20:00Z and waited 40 minutes for sync; the gap is still open.',
    },
    {
      changes: {
        mismatchSince: '2026-09-17T11:58:00Z',
        leftAvailable: '30',
        rightAvailable: '300',
      },
      code: 'raised_oversell_guard',
    },
    { changes: { mismatchSince: null }, code: 'no_recent_agreement' },
  ])(
    'tells how a raised stock gap relates to provider sync: $code',
    ({ changes, code, text }) => {
      const result = diagnose(
        snapshot('inventory_mismatch', changes),
        corpus.now,
      );

      expect(result.detectorDecision.decision).toBe('detect');
      expect(result.facts).toContainEqual(
        expect.objectContaining({ code, ...(text ? { text } : {}) }),
      );
    },
  );
  it('names what each system shows for a differing order line, and which systems do not report it', () => {
    const value = snapshot('order_quantity_mismatch');
    const systems = ['luma-erp', 'jtl', 'shopify'];
    value.evidence = value.evidence.map((item, index) => ({
      ...item,
      connectionId: ['erp-a', 'jtl-a', 'shopify-a'][index]!,
      source: {
        provider: systems[index]!,
        resource: 'order',
        externalId: `order-${index}`,
        scopeKey: '',
      },
    }));
    const result = diagnose(value, corpus.now);

    expect(result.summary).toBe(
      'Luma ERP sets this quantity to 2; Shopify still shows 3; JTL doesn’t report it.',
    );
    expect(result.facts).toContainEqual(
      expect.objectContaining({
        code: 'line_quantities',
        text: 'Luma ERP reports 2 each; JTL reports no current quantity; Shopify reports 3 each.',
      }),
    );
    expect(result.attention.suggested).toBe(true);
    expect(result.nextSteps.map((step) => step.code)).toEqual([
      'reread_order_sources',
      'carry_quantity_change',
    ]);
    expect(result.provenance.validUntil).toBe('2026-09-17T12:03:00.000Z');
  });
  it('adds no sync backstory to legacy stock evidence', () => {
    const result = diagnose(snapshot('inventory_mismatch'), corpus.now);

    expect(result.facts.map((fact) => fact.code)).toEqual([
      'reported_availability',
      'signed_difference',
    ]);
  });
  it('rejects cross-tenant sources and duplicate evidence IDs', () => {
    const value = snapshot('inventory_mismatch');
    value.evidence[0]!.tenantId = 'other';
    expect(() => diagnose(value, corpus.now)).toThrow();
    value.evidence[0]!.tenantId = value.input.facts.tenantId;
    value.evidence[0]!.key = value.evidence[1]!.key;
    expect(() => diagnose(value, corpus.now)).toThrow();
  });
  it('requires reconciliation for unknown effects, including claimed success', () => {
    const result = diagnose(
      snapshot('workflow_failure', { effect: 'unknown', status: 'succeeded' }),
      corpus.now,
    );
    expect(result.nextSteps.map((s) => s.code)).toEqual([
      'reconcile_execution',
    ]);
    expect(result.summary).toContain('uncertain');
  });
  it('uses the escalation window for transient reads without requesting approval', () => {
    const value = snapshot('sync_failure', {
      errorCode: 'timeout',
      retryExhausted: true,
    });
    expect(diagnose(value, corpus.now).attention.suggested).toBe(false);
    const later = new Date(Date.parse(corpus.now) + 1800_000).toISOString();
    expect(diagnose(value, later).attention.suggested).toBe(true);
  });
  it('rejects arbitrary prose and unsafe model actions', () => {
    for (const value of [
      { facts: ['invented'] },
      { hypotheses: [], action: 'inventory.write' },
      { hypotheses: [{ code: 'cause', evidenceRefs: [] }] },
    ])
      expect(() => selectionSchema.parse(value)).toThrow();
  });
  it('bounds providers that ignore cancellation', async () => {
    let signal: AbortSignal | undefined;
    await expect(
      boundedInvestigation((s) => {
        signal = s;

        return new Promise(() => {});
      }, 5),
    ).rejects.toThrow('timed out');
    expect(signal?.aborted).toBe(true);
  });
});

it('withholds changed-authority recommendations without rewriting the stored diagnosis', async () => {
  const input = snapshot('inventory_mismatch');
  const document = diagnose(input, corpus.now);
  const original = structuredClone(document);
  const tenantId = input.input.facts.tenantId;
  const context = makeTenantContext(
    { userId: 'operator', sessionId: 'session' },
    {
      id: tenantId,
      name: 'Store',
      slug: 'store',
      dataRegion: 'AU',
      status: 'active',
    },
    builtInMembership(
      { id: 'member', organizationId: tenantId, userId: 'operator' },
      'owner',
    ),
    'request',
  );
  let current = true;
  const complete = vi.fn(async () => true);
  const service = createDiagnosisService(
    {
      current: async () => ({ snapshot: input, document, resolved: false }),
      history: async () => [document],
      complete,
    },
    () => new Date(corpus.now),
    {
      id: (value) => value,
      parse: (value) => value,
      selection: selectionSchema,
      trace: (requestId) => ({ requestId, traceId: 'trace', spanId: 'span' }),
      bounded: (work) => work(new AbortController().signal),
    },
    { authorityCurrent: async () => current },
  );
  expect((await service.get(context, input.exceptionId))?.superseded).toBe(
    false,
  );
  current = false;
  expect(await service.get(context, input.exceptionId)).toMatchObject({
    superseded: true,
    status: 'insufficient_evidence',
    reason: 'source_authority_changed',
    nextSteps: [],
  });
  expect(document).toEqual(original);
  expect(complete).not.toHaveBeenCalled();
});
