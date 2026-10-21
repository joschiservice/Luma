import type { OrderChangePlan, OrderChangePlans } from '@luma/api-contract';
import type { InstalledConnection } from '@luma/connections';
import type { TenantContext } from '@luma/identity';
import type { CaseRun, ProcessStepOutput } from '@luma/workflows';
import { compileProcessWorkflow } from '@luma/workflows/composition';
import { describe, expect, it, vi } from 'vitest';

import { quantityChangeSource } from '../domain/case-workflows.js';
import { createQuantityChangeWorkflow } from './quantity-change.js';

const context = { tenantId: 'tenant', actor: { id: 'principal' } } as never;
const orderId = '00000000-0000-4000-8000-000000000010';
const lineKey = '00000000-0000-4000-8000-000000000020';
const erp = '00000000-0000-4000-8000-000000000001';
const jtl = '00000000-0000-4000-8000-000000000002';
const shop = '00000000-0000-4000-8000-000000000003';
const asOf = new Date().toISOString();
const version = compileProcessWorkflow(quantityChangeSource);

const run = {
  run: {
    id: '00000000-0000-4000-8000-0000000000aa',
    subject: { kind: 'order', id: orderId },
  },
  signal: {
    id: 'case',
    issueType: 'order_quantity_mismatch',
    subject: { kind: 'order', id: orderId, scope: [lineKey, erp, jtl, shop] },
  },
  stop: null,
} as unknown as CaseRun;

const step = (
  overrides: Partial<OrderChangePlan['steps'][number]> = {},
): OrderChangePlan['steps'][number] => ({
  id: '1-update_quantity',
  kind: 'update_record',
  action: 'update_quantity',
  performer: 'luma',
  role: null,
  connectionId: shop,
  capability: 'orders.quantity.edit',
  executable: true,
  blockedBy: null,
  permission: 'shopify:order_edits.apply',
  viewerCanRequest: true,
  handoff: {
    orderExternalId: 'gid://shopify/Order/1',
    lines: [{ externalId: 'gid://shopify/LineItem/5', quantity: '1' }],
  },
  ...overrides,
});

function plan(overrides: Partial<OrderChangePlan> = {}): OrderChangePlan {
  return {
    change: {
      kind: 'quantity',
      origin: 'detected',
      lineKey,
      line: null,
      from: '2',
      to: '1',
      unit: 'each',
    },
    acknowledgements: [
      {
        connectionId: erp,
        state: 'reflects',
        value: '1',
        readAt: asOf,
        fresh: true,
      },
      {
        connectionId: jtl,
        state: 'unknown',
        value: null,
        readAt: asOf,
        fresh: true,
      },
      {
        connectionId: shop,
        state: 'differs',
        value: '2',
        readAt: asOf,
        fresh: true,
      },
    ],
    shipped: [],
    safety: { state: 'safe', reasons: [] },
    steps: [step()],
    ...overrides,
  };
}

function workflow(current: () => OrderChangePlan) {
  const plans = vi.fn(async (): Promise<OrderChangePlans> => ({
    orderId,
    comparisonState: 'confirmed',
    plans: [current()],
    hidden: [],
    asOf,
  }));
  const refresh = vi.fn(async () => undefined);
  const edits = {
    status: vi.fn(async () => null),
    preview: vi.fn(async () => ({
      state: 'approval_required' as const,
      decisionId: 'decision',
      denial: null,
      acceptance: 'not_sent' as const,
      canExecute: false,
      observeOnly: false,
      lines: [],
    })),
    execute: vi.fn(),
    check: vi.fn(),
  };
  const adapter = createQuantityChangeWorkflow({
    edits: edits as never,
    plans,
    refresh,
    connections: async () =>
      [
        {
          id: shop,
          provider: 'shopify',
          status: 'active',
          granted: ['orders.quantity.edit', 'fulfillment.read'],
        },
      ] as unknown as InstalledConnection[],
    version,
    id: (value) =>
      `00000000-0000-4000-8000-${value.length.toString().padStart(12, '0')}`,
    now: () => new Date(),
  });

  return { adapter, plans, refresh, edits };
}

const readStep = (id: 'plan' | 'replan') =>
  version.steps.find((item) => item.id === id) as Extract<
    (typeof version.steps)[number],
    { kind: 'read' }
  >;

const output = (values: ProcessStepOutput['values']): ProcessStepOutput => ({
  stepId: 'replan',
  kind: 'read',
  state: 'completed',
  values,
  evidenceRefs: ['plan'],
  recordedAt: asOf,
});

describe('order quantity change workflow', () => {
  it('pins the authoritative quantity and hands started work to the warehouse', async () => {
    const f = workflow(() =>
      plan({
        safety: {
          state: 'unsafe',
          reasons: [{ code: 'work_started', connectionId: jtl, lineKey }],
        },
        steps: [step({ executable: false, blockedBy: 'unsafe' })],
      }),
    );
    const result = await f.adapter.read(
      context as TenantContext,
      run,
      readStep('plan'),
      [],
    );

    expect(f.refresh).toHaveBeenCalledWith(context, orderId, 0);
    expect(f.plans).toHaveBeenLastCalledWith(context, orderId, {
      kind: 'quantity',
      lineKey,
      quantity: '1',
    });
    expect(result.values).toEqual({
      ready: true,
      targetQuantity: 1,
      workStarted: true,
      problem: 'The warehouse has started work on this line.',
    });
  });

  it('hands shipped units to a person and keeps a later reread on the pinned target', async () => {
    const f = workflow(() =>
      plan({
        safety: {
          state: 'unsafe',
          reasons: [
            { code: 'fulfilled_beyond_target', connectionId: jtl, lineKey },
          ],
        },
        steps: [step({ executable: false, blockedBy: 'unsafe' })],
      }),
    );
    const result = await f.adapter.read(
      context as TenantContext,
      run,
      readStep('replan'),
      [output({ targetQuantity: 1 })],
    );

    expect(f.plans).toHaveBeenCalledTimes(1);
    expect(result.values).toMatchObject({
      ready: false,
      safe: false,
      shopifyDiffers: true,
      problem:
        'More units have shipped than the new quantity, so a return or refund comes first.',
    });
  });

  it('reports that Shopify already shows the value, so the run ends without a change', async () => {
    const f = workflow(() =>
      plan({
        acknowledgements: plan().acknowledgements.map((item) =>
          item.connectionId === shop
            ? { ...item, state: 'reflects', value: '1' }
            : item,
        ),
        steps: [],
      }),
    );
    const result = await f.adapter.read(
      context as TenantContext,
      run,
      readStep('replan'),
      [output({ targetQuantity: 1 })],
    );

    expect(result.values).toMatchObject({ shopifyDiffers: false });
  });

  it('binds the Shopify edit to the plan’s exact lines and waits for approval', async () => {
    const f = workflow(() => plan());
    const action = version.steps.find(
      (item) => item.id === 'edit-shopify',
    ) as Extract<(typeof version.steps)[number], { kind: 'capability' }>;
    const result = await f.adapter.action(
      context as TenantContext,
      run,
      action,
      [output({ targetQuantity: 1 })],
    );

    expect(f.edits.preview).toHaveBeenCalledWith(context, {
      connectionId: shop,
      orderId: 'gid://shopify/Order/1',
      requestId: expect.any(String),
      change: {
        lines: [{ lineItemId: 'gid://shopify/LineItem/5', quantity: 1 }],
        restock: true,
      },
    });
    expect(result).toMatchObject({
      state: 'awaiting_approval',
      decisionId: 'decision',
    });
  });

  it('verifies only when every system that reports the line shows it, listing the others apart', async () => {
    let current = plan({
      acknowledgements: plan().acknowledgements.map((item) =>
        item.connectionId === shop
          ? { ...item, state: 'reflects', value: '1' }
          : item,
      ),
      steps: [],
    });
    const f = workflow(() => current);
    f.edits.status.mockResolvedValue({
      acceptance: 'accepted',
      state: 'verified',
    } as never);
    f.edits.check.mockResolvedValue({
      state: 'verified',
      lines: [
        {
          lineItemId: 'gid://shopify/LineItem/5',
          currentQuantity: 2,
          quantity: 1,
        },
      ],
    });
    const check = version.steps.find(
      (item) => item.id === 'check-everywhere',
    ) as Extract<(typeof version.steps)[number], { kind: 'verification' }>;
    const previous = [output({ targetQuantity: 1 })];

    expect(
      await f.adapter.verify(context as TenantContext, run, check, previous),
    ).toMatchObject({
      state: 'verified',
      values: { quantity: 1, agreed: true, reporting: 2, notReporting: 1 },
    });
    current = plan({
      acknowledgements: plan().acknowledgements.map((item) =>
        item.connectionId === shop
          ? { ...item, state: 'unknown', fresh: false }
          : item,
      ),
      safety: {
        state: 'unknown',
        reasons: [
          { code: 'stale_evidence', connectionId: shop, lineKey: null },
        ],
      },
    });
    expect(
      await f.adapter.verify(context as TenantContext, run, check, previous),
    ).toMatchObject({
      state: 'inconclusive',
      values: { agreed: false },
    });
  });
});
