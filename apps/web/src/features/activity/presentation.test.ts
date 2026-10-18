import type { ActivityEvent } from '@luma/api-contract';
import { expect, it } from 'vitest';

import {
  activityChangeLabel,
  activityConnectionOptions,
  activityDayLabel,
  activityDays,
  activityExportLabels,
  activityHref,
  activityLabel,
  activityQuickView,
  activityRecordLink,
  activitySearchIssueClasses,
  activityState,
  activitySteps,
  activityStepState,
  activitySubject,
  activitySystemOptions,
  activityTitle,
} from './presentation';

const event = (patch: Partial<ActivityEvent>): ActivityEvent => ({
  id: 'event',
  recordedAt: '2026-10-15T10:00:00Z',
  occurredAt: null,
  actor: { kind: 'luma', id: null, name: null, email: null, workflow: null },
  action: 'exception.detected',
  type: 'issue',
  outcome: 'recorded',
  exceptionId: null,
  proposalId: null,
  attemptId: null,
  connectionId: null,
  system: null,
  resource: null,
  playbookId: null,
  mode: 'unrecorded',
  summary: null,
  executionState: null,
  verificationPhase: null,
  failureCode: null,
  connections: [],
  dispatch: null,
  verification: null,
  evidenceRefs: [],
  ...patch,
});

it('reads activity codes as plain labels', () => {
  expect(activityLabel('provider_accepted')).toBe(
    'Accepted by the connected system',
  );
  expect(activityLabel('provider_accepted', 'shopify')).toBe(
    'Accepted by Shopify',
  );
  expect(activityLabel('manually_disposed')).toBe('Closed manually');
  expect(activityLabel('execution.completed')).toBe('Change attempt finished');
  expect(activityLabel('purchase_order.created')).toBe(
    'Purchase order created',
  );
  expect(activityLabel('connection.paused')).toBe('Connection paused');
  expect(activityChangeLabel('orders.shipping-method.write')).toBe(
    'Change the order’s shipping method',
  );
});

it('treats only verified outcomes as confirmed results', () => {
  expect(activityState('verified')).toBe('verified');
  expect(activityState('provider_accepted')).toBe('running');
  expect(activityState('failed')).toBe('error');
});

const sources = [
  {
    id: '11111111-1111-4111-8111-111111111111',
    label: 'Store',
    system: 'shopify',
  },
  {
    id: '22222222-2222-4222-8222-222222222222',
    label: 'Outlet',
    system: 'shopify',
  },
  {
    id: '33333333-3333-4333-8333-333333333333',
    label: 'ERP',
    system: 'jtl-cloud',
  },
];

it('offers each connected system once and keeps an applied unknown system', () => {
  expect(activitySystemOptions(sources, undefined)).toEqual([
    { value: 'shopify', label: 'Shopify' },
    { value: 'jtl-cloud', label: 'JTL Cloud' },
  ]);
  expect(activitySystemOptions([], 'legacy').map((o) => o.value)).toEqual([
    'legacy',
  ]);
});

it('names connections and shortens an applied connection that is not listed', () => {
  expect(activityConnectionOptions(sources, sources[0]!.id)).toHaveLength(3);
  expect(
    activityConnectionOptions(
      sources,
      '44444444-4444-4444-8444-444444444444',
    ).at(-1),
  ).toEqual({
    value: '44444444-4444-4444-8444-444444444444',
    label: 'Connection 44444444',
  });
});

it('keeps prose and SKU punctuation while naming capability codes for business events', () => {
  expect(
    activityTitle({
      type: 'verification',
      action: 'execution.completed',
      summary: 'Stock for LS-SAND-M matches JTL-Wawi again.',
    }),
  ).toBe('Stock for LS-SAND-M matches JTL-Wawi again.');
  expect(
    activityTitle({
      type: 'verification',
      action: 'execution.completed',
      summary: 'orders.shipping-method.write',
    }),
  ).toBe('Change the order’s shipping method');
  expect(
    activityTitle({
      type: 'verification',
      action: 'workflow.verification',
      summary: null,
      actor: {
        kind: 'luma',
        id: null,
        name: null,
        email: null,
        workflow: {
          id: 'inventory-replenishment',
          name: 'Replenish low stock',
        },
      },
    }),
  ).toBe('Replenish low stock');
});

it('names access changes by what happened, with the role as context', () => {
  const added = event({
    type: 'access',
    action: 'member.add',
    summary: 'Admin',
  });
  expect(activityTitle(added)).toBe('Member added');
  expect(activitySubject(added)).toEqual(['Admin']);
});

it('names erasures by what happened, with their counts and no customer details', () => {
  const erased = event({
    type: 'privacy',
    action: 'customers.erased',
    summary: '1,14,6,2,1',
  });
  expect(activityTitle(erased)).toBe('Customer erased');
  expect(activitySubject(erased)).toEqual([
    'Profiles: 1 · Messages: 14 · Threads: 6 · Replies: 2 · Mailbox rules: 1',
  ]);
});

it('says what an event concerns without storage IDs', () => {
  expect(
    activitySubject(
      event({
        issueClass: 'stuck_fulfillment',
        resourceKind: 'fulfillment',
        resource: '123e7da6-4d18-45ce-ae41-03ed4abddc59',
      }),
    ),
  ).toEqual(['Fulfillment delay']);
  expect(
    activitySubject(
      event({
        resourceKind: 'sku',
        resource: '37832c66-860f-4074-a308-b32d68e1e5c2',
      }),
    ),
  ).toEqual(['Product']);
  expect(
    activitySubject(event({ resourceKind: 'order', resource: '1042' })),
  ).toEqual(['Order 1042']);
  expect(
    activitySubject(event({ resourceKind: 'order', resource: 'Order 1042' })),
  ).toEqual(['Order 1042']);
});

it('groups events by workspace day and lists repeated events once', () => {
  const days = activityDays(
    [
      event({ id: 'a', recordedAt: '2026-10-15T01:00:00Z' }),
      event({ id: 'b', recordedAt: '2026-10-14T20:00:00Z' }),
      event({ id: 'a', recordedAt: '2026-10-15T01:00:00Z' }),
      event({ id: 'c', recordedAt: '2026-10-14T10:00:00Z' }),
    ],
    'Australia/Sydney',
  );
  // 20:00 UTC on the 14th is already the 15th in Sydney.
  expect(
    days.map((day) => [day.day, day.items.map((item) => item.id)]),
  ).toEqual([
    ['2026-10-15', ['a', 'b']],
    ['2026-10-14', ['c']],
  ]);
  expect(activityDayLabel('2026-10-15', '2026-10-15')).toBe('Today');
  expect(activityDayLabel('2026-10-14', '2026-10-15')).toBe('Yesterday');
  expect(activityDayLabel('2026-10-12', '2026-10-15')).toBe(
    'Monday 12 October',
  );
  expect(activityDayLabel('2025-12-31', '2026-01-02')).toBe(
    'Wednesday, 31 December 2025',
  );
});

it('recognizes the quick views by their outcomes in any order', () => {
  expect(activityQuickView(undefined)).toBe('all');
  expect(activityQuickView(['uncertain', 'failed', 'escalated'])).toBe(
    'attention',
  );
  expect(activityQuickView(['verified'])).toBe('verified');
  expect(activityQuickView(['failed'])).toBeNull();
});

it('orders steps oldest first and marks routine and started checks', () => {
  const item = event({
    id: 'resolved',
    action: 'exception.resolved',
    outcome: 'verified',
    recordedAt: '2026-10-15T10:05:00Z',
    steps: [
      event({
        id: 'rules',
        action: 'policy.evaluated',
        recordedAt: '2026-10-15T10:01:00Z',
      }),
      event({ id: 'detected', recordedAt: '2026-10-15T10:00:00Z' }),
      event({
        id: 'pending',
        action: 'exception.verification_attempt',
        outcome: 'uncertain',
        verificationPhase: 'pending',
        recordedAt: '2026-10-15T10:04:00Z',
      }),
      event({
        id: 'denied',
        action: 'policy.evaluated',
        outcome: 'failed',
        recordedAt: '2026-10-15T10:02:00Z',
      }),
    ],
  });
  const steps = activitySteps(item);
  expect(
    steps.map((step) => [step.event.id, step.routine, step.current]),
  ).toEqual([
    ['detected', false, false],
    ['rules', true, false],
    ['denied', false, false],
    ['pending', true, false],
    ['resolved', false, true],
  ]);
  // A started check waits for its result instead of reading as unclear.
  expect(activityStepState(steps[3]!.event)).toBe('waiting');
});

it('links events to the record they can be acted on in', () => {
  const issue = event({ exceptionId: '22222222-2222-4222-8222-222222222222' });
  expect(activityRecordLink(issue, 'org')).toEqual({
    href: '/app/org/exceptions/22222222-2222-4222-8222-222222222222',
    label: 'Open issue and evidence',
  });
  expect(activityRecordLink(event({}), 'org')).toBeUndefined();
  expect(activityHref(event({ id: 'e1' }), 'org')).toBe(
    '/app/org/activity?event=e1',
  );
});

it('finds issue kinds by their names in the reader’s language', () => {
  expect(activitySearchIssueClasses('fulfillment DELAY')).toEqual([
    'stuck_fulfillment',
  ]);
  expect(activitySearchIssueClasses('mismatch')).toEqual([
    'inventory_mismatch',
  ]);
  // Short text would name too many kinds.
  expect(activitySearchIssueClasses('st')).toEqual([]);
});

it('names export headings and recorded codes for the reader', () => {
  const labels = activityExportLabels(sources);
  expect(labels.headings.outcome).toBe('Outcome');
  expect(labels.values).toMatchObject({
    'outcome:verified': 'Verified',
    'action:case.approve': 'Change approved',
    'actorKind:luma': 'Luma',
    'issueClass:stuck_fulfillment': 'Fulfillment delay',
    'system:jtl-cloud': 'JTL Cloud',
    'verification:passed': 'Confirmed',
  });
  // Bounded well below what the API accepts.
  expect(Object.keys(labels.values).length).toBeLessThan(1000);
});
