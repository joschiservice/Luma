import { describe, expect, it } from 'vitest';
import { shippingMethodPlaybook } from '#modules/workflows/domain/shipping-method-playbook';
import {
  compilePlaybook,
  parsePlaybookCode,
  printPlaybookCode,
  parsePlaybookSnapshot,
} from '#modules/workflows/infrastructure/playbook-schema';
import { playbookEligible } from '#modules/workflows/domain/playbook';

const snapshot = {
  inputs: { shippingMethodId: '8' },
  evidence: {
    kind: 'workflow_failure',
    facts: { diagnosisReady: true, methodMapped: true },
    observations: [
      {
        id: '11111111-1111-4111-8111-111111111111',
        observedAt: '2026-09-20T00:00:00.000Z',
        source: 'pilot/1',
      },
    ],
  },
  provenance: { reference: 'pilot/1', capturedAt: '2026-09-20T00:00:00.000Z' },
};
describe('Resolution Playbook V0 authoring', () => {
  it('round-trips the TypeScript code view through the same serializable IR', () => {
    const version = compilePlaybook(shippingMethodPlaybook);
    expect(parsePlaybookCode(printPlaybookCode(version))).toEqual(version);
    expect(JSON.parse(JSON.stringify(version))).toEqual(version);
    expect(
      compilePlaybook(
        Object.fromEntries(Object.entries(shippingMethodPlaybook).reverse()),
      ).digest,
    ).toBe(version.digest);
    const changed = structuredClone(shippingMethodPlaybook);
    changed.ir.verification.maxDurationSeconds = 60;
    expect(compilePlaybook(changed).digest).not.toBe(version.digest);
  });
  it.each(['nested', 'parallel', 'code', 'unknown'])(
    'rejects unsupported %s nodes for author review',
    (kind) => {
      expect(() =>
        compilePlaybook({
          ...shippingMethodPlaybook,
          ir: {
            ...shippingMethodPlaybook.ir,
            action: { ...shippingMethodPlaybook.ir.action, kind },
          },
        }),
      ).toThrow();
    },
  );
  it('rejects executable code, unbound fields, duplicate IDs and unsupported compatibility', () => {
    expect(() =>
      parsePlaybookCode('export default definePlaybook(process.exit());\n'),
    ).toThrow();
    expect(() =>
      compilePlaybook({
        ...shippingMethodPlaybook,
        compatibility: { interpreter: 'future', admission: 1 },
      }),
    ).toThrow();
    const invalid = structuredClone(shippingMethodPlaybook);
    invalid.ir.eligibility.all[0]!.field = 'undeclared';
    expect(() => compilePlaybook(invalid)).toThrow();
    invalid.ir.eligibility.all[0]!.field = 'diagnosisReady';
    invalid.ir.recovery.id = invalid.ir.action.id;
    expect(() => compilePlaybook(invalid)).toThrow();
    invalid.ir.recovery.id = 'review';
    invalid.ir.action.minimumRisk = 'low';
    expect(() => compilePlaybook(invalid)).toThrow();
  });
  it('requires exact typed inputs and evidence; rejects stale and future observations', () => {
    const version = compilePlaybook(shippingMethodPlaybook);
    expect(parsePlaybookSnapshot(snapshot, version)).toEqual(snapshot);
    expect(() =>
      parsePlaybookSnapshot(
        { ...snapshot, inputs: { shippingMethodId: 8 } },
        version,
      ),
    ).toThrow();
    const now = Date.parse(snapshot.provenance.capturedAt);
    expect(playbookEligible(version.ir, snapshot, now)).toBe('eligible');
    expect(playbookEligible(version.ir, snapshot, now + 300_001)).toBe(
      'stale_evidence',
    );
    expect(playbookEligible(version.ir, snapshot, now - 1)).toBe(
      'stale_evidence',
    );
    expect(
      playbookEligible(
        version.ir,
        {
          ...snapshot,
          evidence: {
            ...snapshot.evidence,
            facts: { diagnosisReady: false, methodMapped: true },
          },
        },
        now,
      ),
    ).toBe('ineligible');
  });
});
