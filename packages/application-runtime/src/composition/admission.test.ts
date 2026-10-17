import type { BoundActionStep } from '@luma/execution';
import type { TenantContext } from '@luma/identity';
import { describe, expect, it } from 'vitest';

import { routeAdmissionEligibility } from './admission.js';

const context = {} as TenantContext;
const step = (
  capability: string,
  subject?: { kind: string; id: string },
): BoundActionStep =>
  ({
    action: { capability },
    ...(subject ? { subject } : {}),
  }) as BoundActionStep;

describe('routeAdmissionEligibility', () => {
  const calls: string[] = [];
  const named =
    (name: string, result = true) =>
    async () => {
      calls.push(name);

      return result;
    };
  const eligible = routeAdmissionEligibility({
    fieldWrite: {
      matches: (capability) => capability === 'fields.write',
      eligible: named('field'),
    },
    subjects: {
      purchase_order_change: named('purchase_order_change'),
      purchasing_plan: named('purchasing_plan'),
      purchase_order_submission: named('purchase_order_submission'),
      message_outbound: named('message_outbound'),
      return_case_creation: named('return_case_creation'),
      return_case_settlement: named('return_case_settlement'),
      return_case_exchange: named('return_case_exchange'),
      supplier_follow_up: named('supplier_follow_up', false),
    },
    otherSubject: named('replenishment'),
    noSubject: named('resolution'),
  });

  it('checks field writes before any subject', async () => {
    calls.length = 0;
    await eligible(
      context,
      step('fields.write', { kind: 'message_outbound', id: 'm' }),
    );

    expect(calls).toEqual(['field']);
  });

  it('routes owned subjects, other subjects and subjectless steps', async () => {
    calls.length = 0;
    await eligible(
      context,
      step('messages.send', { kind: 'message_outbound', id: 'm' }),
    );
    await eligible(
      context,
      step('purchase-orders.create', { kind: 'replenishment_rule', id: 'r' }),
    );
    await eligible(context, step('inventory.set'));

    expect(calls).toEqual(['message_outbound', 'replenishment', 'resolution']);
    expect(
      await eligible(
        context,
        step('x', { kind: 'supplier_follow_up', id: 'f' }),
      ),
    ).toBe(false);
  });
});
