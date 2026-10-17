import { describe, expect, it } from 'vitest';

import {
  type CustomFieldDecision,
  presentCustomFieldChange,
  presentHumanTask,
} from './workflow-step-decisions.js';

const change = (
  overrides: Partial<CustomFieldDecision> = {},
): CustomFieldDecision => ({
  runId: 'run',
  stepId: 'set-field',
  field: { id: 'priority', label: { en: 'Priority' } },
  recordType: 'order',
  recordId: '1001',
  beforeValue: 'low',
  proposedValue: 'high',
  requesterId: 'requester',
  requestedAt: '2026-10-01T09:00:00.000Z',
  expiresAt: '2026-10-01T10:00:00.000Z',
  canRespond: true,
  requireIndependentApproval: true,
  stale: false,
  ...overrides,
});

describe('presentCustomFieldChange', () => {
  it('lets a permitted reader decide a current proposal on its record', () => {
    const item = presentCustomFieldChange(change(), 'reviewer');

    expect(item).toMatchObject({
      response: 'decide',
      domain: 'orders',
      record: { kind: 'order', id: '1001' },
      change: [
        { label: 'Before', value: '"low"' },
        { label: 'After', value: '"high"' },
      ],
    });
  });

  it('shows a stale proposal without a decision', () => {
    const item = presentCustomFieldChange(change({ stale: true }), 'reviewer');

    expect(item.response).toBe('view_only');
    expect(item.why).toContain('changed after this proposal');
  });

  it('makes the requester wait when another person must approve', () => {
    const item = presentCustomFieldChange(
      change({ canRespond: false, recordType: 'product' }),
      'requester',
    );

    expect(item).toMatchObject({
      response: 'awaiting_other',
      domain: 'inventory',
      record: { kind: 'sku', id: '1001' },
    });
  });

  it('places records without a page in procurement and links nothing', () => {
    const item = presentCustomFieldChange(
      change({ recordType: 'purchase_order', canRespond: false }),
      'reviewer',
    );

    expect(item).toMatchObject({
      response: 'view_only',
      domain: 'procurement',
      record: null,
    });
  });
});

describe('presentHumanTask', () => {
  it('assigns the task to the reader and explains an escalation', () => {
    const item = presentHumanTask(
      {
        runId: 'run',
        stepId: 'confirm',
        definitionId: 'order-check',
        subject: { kind: 'order', id: '1001' },
        instructions: 'Confirm the address',
        evidence: 'text',
        dueAt: '2026-10-01T10:00:00.000Z',
        createdAt: '2026-10-01T09:00:00.000Z',
        escalatedAt: '2026-10-01T10:05:00.000Z',
      },
      'reader',
    );

    expect(item).toMatchObject({
      id: 'human-task:run:confirm',
      title: 'Confirm the address',
      ownerAssignment: { assigneeId: 'reader', revision: 0 },
      record: { kind: 'order', id: '1001' },
    });
    expect(item.why).toContain('overdue');
  });
});
