import { describe, expect, it } from 'vitest';

import {
  type AutonomyHistory,
  autonomyTrackRecord,
  evaluateAutonomy,
  previewAutonomy,
  type ScopedAutonomyPolicy,
  scopedResponsibility,
  type ScopedResponsibilityFacts,
} from './scoped-autonomy.js';

const now = Date.parse('2026-10-13T12:00:00Z');
const facts: ScopedResponsibilityFacts = {
  recordId: 'order',
  connectionId: 'connection',
  supplierId: 'supplier',
  locationId: 'warehouse',
  quantity: '1',
  unit: 'follow_up',
  exposure: null,
  observedAt: '2026-10-13T11:59:00Z',
  complete: true,
  environment: 'live',
  environmentProvenance: {
    basis: 'reviewed_workspace_declaration',
    connectionId: 'source',
    connectionVersion: 1,
    credentialVersion: 1,
    sourceBinding: 'bound-source',
    declarationRevision: 1,
    evidenceId: 'review',
  },
};
const policy: ScopedAutonomyPolicy = {
  id: 'policy',
  tenantId: 'tenant',
  revision: 1,
  name: 'Supplier follow-ups',
  mode: 'autonomous',
  paused: false,
  pausedConnectionIds: [],
  revoked: false,
  circuitReason: null,
  scopeHash: 'scope',
  scope: {
    capability: scopedResponsibility,
    connectionIds: ['connection'],
    supplierIds: ['supplier'],
    locationIds: ['warehouse'],
    recordIds: ['order'],
    unit: 'follow_up',
    perActionQuantity: '1',
    dailyQuantity: '10',
    money: null,
    maxEvidenceAgeSeconds: 300,
  },
  updatedAt: '2026-10-13T11:58:00Z',
  updatedBy: 'owner',
};
const evaluate = (changed: Partial<ScopedResponsibilityFacts>) =>
  evaluateAutonomy(policy, { ...facts, ...changed }, now, 'low', 'low');

describe('bounded responsibility admission', () => {
  it('allows the exact reviewed scope while requiring missing restricted identities to remain unknown', () => {
    expect(evaluate({}).outcome).toBe('allowed');
    expect(evaluate({ supplierId: null })).toEqual({
      outcome: 'denied',
      reason: 'out_of_scope',
    });
    expect(evaluate({ locationId: 'another warehouse' }).outcome).toBe(
      'denied',
    );
    expect(evaluate({ recordId: 'another order' }).outcome).toBe('denied');
  });
  it('cannot lower capability or proposed risk floors', () => {
    expect(evaluateAutonomy(policy, facts, now, 'low', 'medium')).toEqual({
      outcome: 'approval_required',
      reason: 'risk_floor',
    });
    expect(evaluateAutonomy(policy, facts, now, 'high', 'low').outcome).toBe(
      'approval_required',
    );
  });
  it('rejects stale, future, missing or incomplete evidence and excess quantities', () => {
    for (const changed of [
      { observedAt: null },
      { observedAt: '2026-10-13T11:50:00Z' },
      { observedAt: '2026-10-13T12:01:00Z' },
      { complete: false },
    ])
      expect(evaluate(changed)).toEqual({
        outcome: 'denied',
        reason: 'stale_evidence',
      });
    expect(evaluate({ quantity: '1.000001' }).reason).toBe('quantity_limit');
    expect(evaluate({ quantity: '-1' }).reason).toBe('quantity_limit');
  });
  it('never invents a price or exchanges currency to meet monetary limits', () => {
    const bounded = {
      ...policy,
      scope: {
        ...policy.scope,
        money: { currency: 'EUR', perAction: '100', daily: '200' },
      },
    };
    expect(evaluateAutonomy(bounded, facts, now, 'low', 'low').reason).toBe(
      'money_unknown',
    );
    expect(
      evaluateAutonomy(
        bounded,
        { ...facts, exposure: { amount: '50', currency: 'USD' } },
        now,
        'low',
        'low',
      ).reason,
    ).toBe('money_unknown');
    expect(
      evaluateAutonomy(
        bounded,
        { ...facts, exposure: { amount: '100.000001', currency: 'EUR' } },
        now,
        'low',
        'low',
      ).reason,
    ).toBe('money_limit');
  });
  it('respects Manual, Assisted, per-connection pause and permanent revocation', () => {
    expect(
      evaluateAutonomy({ ...policy, mode: 'manual' }, facts, now, 'low', 'low')
        .reason,
    ).toBe('manual');
    expect(
      evaluateAutonomy(
        { ...policy, mode: 'assisted' },
        facts,
        now,
        'low',
        'low',
      ).outcome,
    ).toBe('approval_required');
    expect(
      evaluateAutonomy(
        { ...policy, pausedConnectionIds: ['connection'] },
        facts,
        now,
        'low',
        'low',
      ).reason,
    ).toBe('paused');
    expect(
      evaluateAutonomy({ ...policy, revoked: true }, facts, now, 'low', 'low')
        .reason,
    ).toBe('paused');
  });
});

const history = (
  environment: ScopedResponsibilityFacts['environment'],
): AutonomyHistory[] =>
  Array.from({ length: 20 }, (_, index) => ({
    proposalId: String(index),
    policyId: policy.id,
    scopeHash: policy.scopeHash,
    facts: { ...facts, environment },
    actionRisk: 'low',
    minimumRisk: 'low',
    review: 'accepted',
    verification: 'passed',
    dispatch: 'dispatched',
    at: '2026-10-13T11:59:00Z',
  }));

describe('earned autonomy evidence', () => {
  it('requires actual live review and verification rather than model confidence, synthetic data or unclassified records', () => {
    expect(
      autonomyTrackRecord(history('live'), 'scope').promotionEligible,
    ).toBe(true);
    for (const environment of ['synthetic', 'unknown'] as const) {
      const result = autonomyTrackRecord(history(environment), 'scope');
      expect(result.promotionEligible).toBe(false);
      expect(result.live).toBe(0);
      expect(result.acceptanceRate).toBeNull();
    }
  });
  it('does not transfer an old scope record or unresolved failure to a promoted scope', () => {
    expect(
      autonomyTrackRecord(history('live'), 'changed-scope').promotionEligible,
    ).toBe(false);
    for (const changed of [
      { verification: 'failed' as const },
      { verification: 'unknown' as const },
      { dispatch: 'uncertain' as const },
    ]) {
      const samples = history('live');
      samples[0] = { ...samples[0]!, ...changed };
      expect(autonomyTrackRecord(samples, 'scope').promotionEligible).toBe(
        false,
      );
    }
  });
});

it('previews daily exact budgets chronologically without mixing live and synthetic evidence', () => {
  const samples = history('live').slice(0, 3);
  samples[0] = { ...samples[0]!, at: '2026-10-13T11:59:00Z' };
  samples[1] = { ...samples[1]!, at: '2026-10-13T11:59:01Z' };
  samples[2] = { ...samples[2]!, at: '2026-10-13T11:59:02Z' };
  const limited = { ...policy, scope: { ...policy.scope, dailyQuantity: '2' } };
  const preview = previewAutonomy(limited, [...samples].reverse());
  expect(preview.map((sample) => sample.outcome)).toEqual([
    'denied',
    'allowed',
    'allowed',
  ]);
  expect(preview[0]?.reason).toBe('quantity_limit');
  samples[2] = {
    ...samples[2]!,
    facts: { ...facts, environment: 'synthetic' },
  };
  expect(
    previewAutonomy(limited, samples).every(
      (sample) => sample.outcome === 'allowed',
    ),
  ).toBe(true);
  const moneyPolicy = {
    ...policy,
    scope: {
      ...policy.scope,
      money: { currency: 'EUR', perAction: '0.600001', daily: '1.000001' },
    },
  };
  expect(
    previewAutonomy(
      moneyPolicy,
      samples.map((entry) => ({
        ...entry,
        facts: {
          ...entry.facts,
          environment: 'live',
          exposure: { currency: 'EUR', amount: '0.600001' },
        },
      })),
    ).map((sample) => sample.reason),
  ).toEqual([null, 'money_limit', 'money_limit']);
});

it('rejects automatic unknown or synthetic work and cannot earn promotion from an unbound live label or a replaced declaration', () => {
  for (const changed of [
    { environment: 'unknown' as const },
    { environment: 'synthetic' as const },
    { environmentProvenance: null },
  ]) {
    expect(
      evaluateAutonomy(
        policy,
        { ...facts, ...changed },
        Date.parse('2026-10-13T12:00:00Z'),
        'low',
        'low',
      ),
    ).toMatchObject({ outcome: 'denied', reason: 'stale_evidence' });
  }
  const old = history('live');
  expect(
    autonomyTrackRecord(
      old,
      'scope',
      (f) => f.environmentProvenance?.declarationRevision === 2,
    ).promotionEligible,
  ).toBe(false);
  expect(
    autonomyTrackRecord(
      old.map((e) => ({
        ...e,
        facts: { ...e.facts, environmentProvenance: null },
      })),
      'scope',
    ).promotionEligible,
  ).toBe(false);
  expect(
    autonomyTrackRecord(
      old,
      'scope',
      (f) => f.environmentProvenance?.declarationRevision === 1,
    ).promotionEligible,
  ).toBe(true);
});
