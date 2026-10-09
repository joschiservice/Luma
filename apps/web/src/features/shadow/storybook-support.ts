import type { WorkflowSummary } from '@luma/api-contract';

import { contextFixture } from '../identity/context.fixture';
import type { ShadowComparison, ShadowReport } from './data';

export const organizationId = '22222222-2222-4222-8222-222222222222';

export const exceptionId = '11111111-1111-4111-8111-111111111111';

export const evidenceId = '33333333-3333-4333-8333-333333333333';

export const workflow = 'shipping-method-correction';

export const requests: {
  method: string;
  path: string;
  body: Record<string, unknown>;
}[] = [];

export type PreviewState =
  | 'long_evidence'
  | 'ready'
  | 'empty'
  | 'member'
  | 'denied'
  | 'error'
  | 'uncertain'
  | 'review_uncertain'
  | 'no_candidate'
  | 'report'
  | 'report_empty';
const summary: Omit<WorkflowSummary, 'readiness'> = {
  id: workflow,
  name: 'Correct an order shipping method',
  purpose: 'Apply the mapped shipping method.',
  capability: 'orders.shipping-method.write',
  category: 'resolution',
  systems: ['jtl-cloud'],
  availableVersion: '0.1.0',
  activeVersions: ['0.1.0'],
  status: 'active',
  blockers: [],
};

/** Supplies a bounded shipping prediction for interactive UI previews. */
export function comparison(): ShadowComparison {
  return {
    evaluation: {
      id: '44444444-4444-4444-8444-444444444444',
      incidentId: exceptionId,
      actorId: organizationId,
      workflow,
      mode: 'shadow',
      executed: false,
      createdAt: new Date(Date.now() - 60_000).toISOString(),
      diagnosis: {
        summary: 'The order has no mapped shipping method.',
        revision: 1,
      },
      candidate: {
        version: '0.1.0',
        snapshot: { inputs: { shippingMethodId: 'EXPRESS' } },
        action: {
          capability: 'orders.shipping-method.write',
          target: { kind: 'order', id: exceptionId },
          parameters: {},
          expectedPostcondition: { shippingMethodId: 'EXPRESS' },
        },
      },
      eligibility: 'eligible',
      policy: {
        outcome: 'approval_required',
        reason: 'approval_required',
        version: 'v0.1',
      },
      simulation: {
        modelVersion: 'shipping-method-shadow/1',
        effects: { shippingMethodId: 'EXPRESS' },
        predictedOutcome: 'passed',
        evaluatorVersion: 'shipping-method/1',
        assumptions: [
          'The provider accepts the mapped shipping method.',
          'An authoritative reread confirms the method within the verification window.',
          'A corrected shipping method does not establish shipment or fulfillment.',
        ],
      },
    },
    review: null,
    actual: null,
  };
}

/** Reports missing observations as empty denominators rather than zero performance. */
export function report(items: ShadowComparison[]): ShadowReport {
  const unknown = { numerator: 0, denominator: 0, rate: null };

  return {
    mode: 'shadow',
    workflow,
    since: '2026-09-01T00:00:00Z',
    until: '2026-10-01T00:00:00Z',
    items,
    metrics: {
      evaluations: items.length,
      reviewed: items.filter((i) => i.review).length,
      agreementWithOperator: items.some((i) => i.review?.operatorAction)
        ? { numerator: 1, denominator: 1, rate: 1 }
        : unknown,
      falsePositiveActionRate: unknown,
      missedEligibleCases: unknown,
      predictedVsActualOutcome: items.some((i) => i.actual)
        ? { numerator: 1, denominator: 1, rate: 1 }
        : unknown,
      projectedAutonomousResolutionRate: {
        numerator: 0,
        denominator: items.length,
        rate: items.length ? 0 : null,
      },
      projectedUnnecessaryHumanInterventionRate: unknown,
      operatorTrust: items.some((i) => i.review?.feedback)
        ? { numerator: 1, denominator: 1, rate: 1 }
        : unknown,
    },
  };
}

/** Keeps every preview request local, including uncertain writes and role changes. */
export function mockShadow(state: PreviewState) {
  const original = globalThis.fetch;
  requests.length = 0;
  let item: ShadowComparison | null = [
    'empty',
    'uncertain',
    'report_empty',
  ].includes(state)
    ? null
    : comparison();
  let failed = false;
  if (state === 'no_candidate' && item) {
    item.evaluation.candidate = null;
    item.evaluation.eligibility = 'no_candidate';
    item.evaluation.policy = null;
    item.evaluation.simulation.predictedOutcome = 'inconclusive';
    item.evaluation.simulation.effects = {};
    item.evaluation.simulation.assumptions = [];
  }
  if (state === 'report' && item) {
    item.actual = {
      outcome: 'passed',
      evaluatorVersion: 'shipping-method/1',
      evidenceRefs: [evidenceId],
      occurredAt: new Date().toISOString(),
    };
    item.review = {
      actorId: organizationId,
      actionNeeded: true,
      eligible: true,
      operatorAction: {
        capability: 'orders.shipping-method.write',
        target: { kind: 'order', id: exceptionId },
        parameters: {},
        expectedPostcondition: { shippingMethodId: 'EXPRESS' },
      },
      evidenceRefs: [evidenceId],
      occurredAt: new Date().toISOString(),
      feedback: 'trust',
    };
  }
  globalThis.fetch = async (input, init) => {
    const url = new URL(
      input instanceof Request ? input.url : String(input),
      location.origin,
    );
    if (!url.pathname.startsWith('/api/')) return original(input, init);
    const method =
      input instanceof Request ? input.method : (init?.method ?? 'GET');
    const body = JSON.parse(
      (input instanceof Request
        ? await input.clone().text()
        : String(init?.body ?? '')) || '{}',
    );
    requests.push({ method, path: url.pathname, body });
    const fail = (status: number) =>
      Response.json(
        {
          code: 'SERVICE_UNAVAILABLE',
          message: 'Shadow data is unavailable. Try again.',
          requestId: 'preview',
        },
        { status },
      );
    if (url.pathname.endsWith('/context'))
      return Response.json(
        contextFixture(
          organizationId,
          state === 'member' ? 'member' : 'owner',
          organizationId,
        ),
      );
    if (state === 'denied') return fail(403);
    if (state === 'error') return fail(503);
    if (url.pathname.endsWith('/playbooks'))
      return Response.json({
        items: [{ ...summary, issueType: 'workflow_failure' }],
      });
    if (url.pathname.endsWith('/timeline'))
      return Response.json({ schemaVersion: 1, items: [], nextCursor: null });
    if (url.pathname.endsWith('/evidence'))
      return Response.json({
        schemaVersion: 1,
        items: Array.from(
          { length: state === 'long_evidence' ? 45 : 1 },
          (_, index) => ({
            id:
              state === 'long_evidence'
                ? `33333333-3333-4333-8333-${String(index).padStart(12, '0')}`
                : evidenceId,
            observedAt: new Date(Date.now() - 30_000).toISOString(),
            sourceUpdatedAt: null,
            adapterVersion: '1',
            schemaVersion: 1,
            source: {
              provider: 'JTL',
              resource: 'Order 1042',
              externalId: '1042',
              scopeKey: 'orders',
            },
            completeness: 'complete',
          }),
        ),
        nextCursor: null,
      });
    if (url.pathname.endsWith('/review') && method === 'POST' && item) {
      item.review = {
        ...body,
        actorId: organizationId,
      } as ShadowComparison['review'];

      if (state === 'review_uncertain' && !failed) {
        failed = true;
        throw new TypeError('Preview review response lost');
      }

      return Response.json({ recorded: true });
    }
    if (url.pathname.endsWith(`/exceptions/${exceptionId}/shadow`)) {
      if (method === 'POST') {
        if (!item || item.evaluation.id !== body.id) {
          item = comparison();
          item.evaluation.id = String(body.id);
        }
        if (state === 'uncertain' && !failed) {
          failed = true;
          throw new TypeError('Preview connection lost');
        }

        return Response.json(item.evaluation);
      }

      return Response.json({ item });
    }
    if (url.pathname.endsWith('/shadow'))
      return Response.json(report(item ? [item] : []));

    return fail(404);
  };

  return () => {
    globalThis.fetch = original;
  };
}
