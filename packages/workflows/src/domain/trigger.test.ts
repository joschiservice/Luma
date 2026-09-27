import { describe, expect, it } from 'vitest';

import { shippingMethodPlaybook } from './shipping-method.fixture.js';
import { validateTriggerSignal } from './trigger.js';
import { resolutionWorkflow } from './workflow.js';

const now = Date.parse('2026-09-27T04:00:00Z');
const at = new Date(now).toISOString();
const base = resolutionWorkflow({
  ...shippingMethodPlaybook,
  digest: 'a'.repeat(64),
});
const snapshot = {
  inputs: { shippingMethodId: 'standard' },
  evidence: {
    kind: 'workflow_failure',
    facts: { diagnosisReady: true, methodMapped: true },
    observations: [{ id: 'observation', observedAt: at, source: 'provider' }],
  },
  provenance: { reference: 'signal', capturedAt: at },
};
const subject = { kind: 'order', id: 'order-1' };
const signal = { kind: 'condition', sourceId: 'source-1', occurredAt: at };

describe('Workflow trigger matching', () => {
  const condition = {
    ...base,
    applicability: {
      subjectKind: 'order',
      trigger: {
        kind: 'condition' as const,
        field: 'diagnosisReady',
        equals: true,
      },
    },
  };
  it('matches a declared condition and rejects false or stale evidence', () => {
    expect(() =>
      validateTriggerSignal(condition, subject, signal, snapshot, now),
    ).not.toThrow();
    expect(() =>
      validateTriggerSignal(
        condition,
        subject,
        signal,
        {
          ...snapshot,
          evidence: {
            ...snapshot.evidence,
            facts: { ...snapshot.evidence.facts, diagnosisReady: false },
          },
        },
        now,
      ),
    ).toThrow('does not meet');
    expect(() =>
      validateTriggerSignal(
        condition,
        subject,
        signal,
        snapshot,
        now + 301_000,
      ),
    ).toThrow('expired');
  });
  it('rejects mismatched resources, signals and future evidence', () => {
    expect(() =>
      validateTriggerSignal(
        condition,
        { kind: 'supplier', id: '1' },
        signal,
        snapshot,
        now,
      ),
    ).toThrow('subject type');
    expect(() =>
      validateTriggerSignal(
        condition,
        subject,
        { ...signal, kind: 'manual' },
        snapshot,
        now,
      ),
    ).toThrow('does not match');
    expect(() =>
      validateTriggerSignal(condition, subject, signal, snapshot, now - 1000),
    ).toThrow('future');
  });
  it('binds event context to the configured event type', () => {
    const event = {
      ...base,
      applicability: {
        subjectKind: 'order',
        trigger: { kind: 'event' as const, eventType: 'order.updated' },
      },
    };
    expect(() =>
      validateTriggerSignal(
        event,
        subject,
        { ...signal, kind: 'event' },
        snapshot,
        now,
      ),
    ).toThrow('domain event');
  });
  it('requires new schedules to target a future time', () => {
    const schedule = {
      ...base,
      applicability: {
        subjectKind: 'order',
        trigger: { kind: 'schedule' as const, at },
      },
    };
    expect(() =>
      validateTriggerSignal(
        schedule,
        subject,
        { ...signal, kind: 'schedule' },
        snapshot,
        now,
      ),
    ).toThrow('passed');
  });
});
