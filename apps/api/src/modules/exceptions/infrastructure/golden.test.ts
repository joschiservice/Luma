import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { factSchemas as schemas } from '#modules/exceptions/infrastructure/validation';
import { evaluate } from '#modules/exceptions/domain/evaluate';
import { parseInput } from '#modules/exceptions/infrastructure/validation';
const timestamp = z.string().datetime();
const className = z.enum([
  'sync_failure',
  'stuck_fulfillment',
  'inventory_mismatch',
  'workflow_failure',
]);
const decision = z.discriminatedUnion('decision', [
  z
    .object({
      decision: z.literal('detect'),
      severity: z.enum(['medium', 'high']),
      reason: z.string().min(1),
    })
    .strict(),
  ...(['clear', 'defer', 'reject'] as const).map((value) =>
    z
      .object({
        decision: z.literal(value),
        severity: z.null(),
        reason: z.string().min(1),
      })
      .strict(),
  ),
]);
const corpusSchema = z
  .object({
    schemaVersion: z.literal(1),
    ruleVersion: z.literal('v0.1'),
    synthetic: z.literal(true),
    now: timestamp,
    thresholds: z
      .object({
        freshnessSeconds: z.number().int().positive(),
        pairSkewSeconds: z.number().int().positive(),
        syncFailureSeconds: z.number().int().positive(),
        stuckSeconds: z.number().int().positive(),
        uncertaintySeconds: z.number().int().positive(),
      })
      .strict(),
    bases: z.object(schemas).strict(),
    cases: z
      .array(
        z
          .object({
            id: z.string().min(1),
            exceptionClass: className,
            input: z.record(z.unknown()),
            expected: decision,
          })
          .strict(),
      )
      .min(1),
  })
  .strict();
const corpus = corpusSchema.parse(
  JSON.parse(
    readFileSync(
      new URL(
        '../../../../../../docs/fixtures/exceptions-v0.json',
        import.meta.url,
      ),
      'utf8',
    ),
  ),
);

// Execute the production evaluator against the versioned acceptance corpus.
describe('V0 exception acceptance corpus', () => {
  it.each(corpus.cases)('$id evaluates the golden decision', (testCase) => {
    expect(
      evaluate(
        parseInput(testCase.exceptionClass, {
          ...corpus.bases[testCase.exceptionClass],
          ...testCase.input,
        }),
        corpus.now,
        corpus.thresholds,
      ),
    ).toEqual(testCase.expected);
  });

  it('has unique case IDs and every decision outcome for every class', () => {
    expect(new Set(corpus.cases.map(({ id }) => id)).size).toBe(
      corpus.cases.length,
    );
    for (const name of className.options) {
      const outcomes = new Set(
        corpus.cases
          .filter((c) => c.exceptionClass === name)
          .map((c) => c.expected.decision),
      );
      for (const outcome of ['detect', 'clear', 'defer', 'reject'] as const)
        expect(outcomes.has(outcome)).toBe(true);
    }
  });

  it.each(className.options)(
    '%s includes tenant rejection before detection',
    (name) => {
      expect(corpus.cases).toContainEqual(
        expect.objectContaining({
          exceptionClass: name,
          input: { evidenceTenantId: 'tenant-b' },
          expected: {
            decision: 'reject',
            severity: null,
            reason: 'tenant_mismatch',
          },
        }),
      );
    },
  );

  // Pin the branch inputs as well as outcomes so unrelated cases cannot satisfy coverage.
  it.each([
    {
      id: 'sync-incomplete-success',
      exceptionClass: 'sync_failure',
      input: { status: 'success', errorCode: null, scanComplete: false },
      expected: {
        decision: 'defer',
        severity: null,
        reason: 'incomplete_evidence',
      },
    },
    ...(['cancelled', 'succeeded'] as const).map((status) => ({
      id: `workflow-unknown-effect-${status}`,
      exceptionClass: 'workflow_failure',
      input: {
        status,
        effect: 'unknown',
        executionId: 'execution-1',
        retryExhausted: false,
      },
      expected: {
        decision: 'detect',
        severity: 'high',
        reason: 'reconciliation_required',
      },
    })),
    {
      id: 'fulfillment-unmapped',
      exceptionClass: 'stuck_fulfillment',
      input: { mapped: false },
      expected: {
        decision: 'defer',
        severity: null,
        reason: 'unmapped_fulfillment',
      },
    },
    {
      id: 'fulfillment-incomplete',
      exceptionClass: 'stuck_fulfillment',
      input: { complete: false },
      expected: {
        decision: 'defer',
        severity: null,
        reason: 'incomplete_evidence',
      },
    },
    {
      id: 'fulfillment-negative-quantity',
      exceptionClass: 'stuck_fulfillment',
      input: { quantity: '-1' },
      expected: {
        decision: 'defer',
        severity: null,
        reason: 'invalid_quantity',
      },
    },
  ])('$id covers its documented branch and precedence', (requiredCase) => {
    expect(corpus.cases.find(({ id }) => id === requiredCase.id)).toEqual(
      requiredCase,
    );
  });

  it.each(corpus.cases)(
    '$id has valid normalized facts and evidence',
    (testCase) => {
      const facts = schemas[testCase.exceptionClass].parse({
        ...corpus.bases[testCase.exceptionClass],
        ...testCase.input,
      });
      expect(new Set(facts.evidenceRefs).size).toBe(facts.evidenceRefs.length);
      if (facts.tenantId !== facts.evidenceTenantId) {
        expect(testCase.expected).toEqual({
          decision: 'reject',
          severity: null,
          reason: 'tenant_mismatch',
        });
      }
      if ('effect' in facts && facts.effect === 'unknown')
        expect(facts.executionId).not.toBeNull();
    },
  );

  it('rejects malformed fixture facts instead of silently coercing them', () => {
    const base = corpus.bases.inventory_mismatch;
    for (const invalid of [
      0,
      'NaN',
      '1e3',
      '0.0000001',
      '100000000000000',
      '',
    ]) {
      expect(
        schemas.inventory_mismatch.safeParse({
          ...base,
          leftAvailable: invalid,
        }).success,
      ).toBe(false);
    }
    expect(
      schemas.inventory_mismatch.safeParse({ ...base, leftAvailable: null })
        .success,
    ).toBe(true);
    expect(
      schemas.inventory_mismatch.safeParse({ ...base, tolerance: '-1' })
        .success,
    ).toBe(false);
    expect(
      schemas.inventory_mismatch.safeParse({
        ...base,
        leftObservedAt: 'yesterday',
      }).success,
    ).toBe(false);
    expect(
      schemas.inventory_mismatch.safeParse({ ...base, available: '5' }).success,
    ).toBe(false);
    expect(
      decision.safeParse({
        decision: 'clear',
        severity: 'high',
        reason: 'within_tolerance',
      }).success,
    ).toBe(false);
  });
});
