import { describe, expect, it } from 'vitest';

import { parseAdmissionReference } from './admission.js';
import { parseAction } from './validation.js';

const runId = '00000000-0000-4000-8000-000000000001';
const id = '00000000-0000-4000-8000-000000000002';
const later = '2026-10-27T11:00:00.000Z';

const action = {
  schemaVersion: 1,
  id,
  tenantId: id,
  capability: 'inventory.available.set',
  capabilityVersion: '1',
  connectionId: id,
  target: { kind: 'inventory_level', id },
  parameters: { quantity: 4 },
  preconditions: { evidenceRefs: [id], validUntil: later },
  expectedPostcondition: { quantity: 4 },
  risk: 'low',
  proposedBy: { kind: 'user', id: 'user' },
  expiresAt: later,
};

describe('admission input validation', () => {
  it('accepts only a run and step reference', () => {
    expect(parseAdmissionReference({ runId, stepId: 'correct' })).toEqual({
      runId,
      stepId: 'correct',
    });
  });

  it.each([
    ['a proposal beside the reference', { runId, stepId: 'correct', action }],
    [
      'a tenant beside the reference',
      { runId, stepId: 'correct', tenantId: id },
    ],
    ['a run that is not a UUID', { runId: 'run', stepId: 'correct' }],
    ['an empty step', { runId, stepId: '' }],
    ['a missing step', { runId }],
  ])('rejects %s', (_name, input) => {
    expect(() => parseAdmissionReference(input)).toThrow();
  });

  it('hashes the same action identically regardless of key order', () => {
    const reordered = Object.fromEntries(Object.entries(action).reverse());

    expect(parseAction(reordered).hash).toBe(parseAction(action).hash);
    expect(parseAction(action).hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('returns a frozen action so later steps cannot change what was hashed', () => {
    const { action: parsed } = parseAction(action);

    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.parameters)).toBe(true);
  });

  it.each([
    ['an unknown field', { ...action, credentials: 'secret' }],
    ['a non-UUID proposal ID', { ...action, id: 'proposal' }],
    [
      'an agent without model provenance',
      { ...action, proposedBy: { kind: 'agent', id: 'agent' } },
    ],
    ['an unknown risk', { ...action, risk: 'none' }],
    [
      'evidence without references',
      { ...action, preconditions: { evidenceRefs: [], validUntil: later } },
    ],
  ])('rejects an action with %s', (_name, input) => {
    expect(() => parseAction(input)).toThrow();
  });
});
