import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import type { DiagnosisInput } from '../domain/diagnosis.js';
import { diagnose } from '../domain/diagnosis.js';
import { identity } from '../domain/evaluate.js';
import type { ExceptionClass } from '../domain/facts.js';
import { defaultConfiguration } from '../domain/facts.js';
import { boundedInvestigation, selectionSchema } from './diagnosis-boundary.js';
import { parseInput } from './validation.js';

const corpus = JSON.parse(
  readFileSync(
    new URL('../../../../docs/fixtures/exceptions-v0.json', import.meta.url),
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
