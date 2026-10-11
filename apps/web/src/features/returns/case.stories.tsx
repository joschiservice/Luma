import type { ReturnActionList, ReturnCaseDetail } from '@luma/api-contract';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { useState } from 'react';
import { expect, userEvent, within } from 'storybook/test';

import appStyles from '../../styles.css?inline';
import { ReturnCaseView } from './case';
import { ReturnSettlement } from './case-settlement';
import { detail as sourceDetail } from './returns-fixtures';

const org = '99999999-9999-4999-8999-999999999999';
const alex = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Alex Morgan',
};
const sam = { id: '22222222-2222-4222-8222-222222222222', name: 'Sam Lee' };
const line = (patch: Partial<ReturnCaseDetail['lines'][number]> = {}) => ({
  orderLineId: '33333333-3333-4333-8333-333333333333',
  title: 'Canvas tote, red',
  sku: 'TOTE-RED',
  quantity: 2,
  reason: 'damaged' as const,
  note: 'Strap torn on arrival',
  received: null,
  missing: null,
  resellable: null,
  damaged: null,
  restock: null,
  ...patch,
});

const open: ReturnCaseDetail = {
  case: {
    id: '44444444-4444-4444-8444-444444444444',
    orderId: '55555555-5555-4555-8555-555555555555',
    connectionId: '66666666-6666-4666-8666-666666666666',
    sourceReturnId: null,
    state: 'open',
    stage: 'awaiting_receipt',
    units: 3,
    assignee: sam,
    resolution: null,
    externalNumber: null,
    openedAt: '2026-10-08T09:12:00.000Z',
    updatedAt: '2026-10-08T09:12:00.000Z',
    revision: 2,
    openedBy: alex,
    cancellation: null,
  },
  order: {
    id: '55555555-5555-4555-8555-555555555555',
    number: 'AU-2026-1042',
    connection: {
      id: '66666666-6666-4666-8666-666666666666',
      label: 'JTL-Wawi',
      provider: 'jtl',
    },
  },
  sourceReturn: null,
  lines: [
    line(),
    line({
      orderLineId: '77777777-7777-4777-8777-777777777777',
      title: 'Linen shirt, M',
      sku: 'SHIRT-M',
      quantity: 1,
      reason: 'size_or_fit',
      note: null,
    }),
  ],
  receipt: null,
  inspection: null,
  proposal: null,
  history: [
    {
      id: 'h1',
      kind: 'opened',
      actor: alex,
      at: '2026-10-08T09:12:00.000Z',
      evidence: null,
      details: {
        lines: [
          { orderLineId: '33333333-3333-4333-8333-333333333333', quantity: 2 },
          { orderLineId: '77777777-7777-4777-8777-777777777777', quantity: 1 },
        ],
      },
    },
    {
      id: 'h2',
      kind: 'assigned',
      actor: alex,
      at: '2026-10-08T09:14:00.000Z',
      evidence: null,
      details: { assigneeId: sam.id, assignee: sam },
    },
  ],
  creation: null,
  creationAvailability: {
    blocker: null,
    connection: {
      id: '66666666-6666-4666-8666-666666666666',
      label: 'JTL-Wawi',
    },
  },
  canManage: true,
  asOf: '2026-10-11T08:00:00.000Z',
};

const decided = (at: string, note: string | null) => ({
  by: sam,
  at,
  evidence: { note, link: note ? 'https://evidence.example/photo/1' : null },
});

const proposed: ReturnCaseDetail = {
  ...open,
  case: {
    ...open.case,
    stage: 'proposed',
    resolution: 'refund',
    externalNumber: 'RE-2026-0007',
    revision: 5,
  },
  lines: [
    line({ received: 2, missing: 0, resellable: 1, damaged: 1, restock: 1 }),
    line({
      orderLineId: '77777777-7777-4777-8777-777777777777',
      title: 'Linen shirt, M',
      sku: 'SHIRT-M',
      quantity: 1,
      reason: 'size_or_fit',
      note: null,
      received: 0,
      missing: 1,
      resellable: 0,
      damaged: 0,
      restock: 0,
    }),
  ],
  receipt: decided('2026-10-09T10:00:00.000Z', 'One parcel, shirt missing'),
  inspection: decided('2026-10-09T10:20:00.000Z', 'Strap torn'),
  proposal: { ...decided('2026-10-09T11:00:00.000Z', null), kind: 'refund' },
  creation: {
    id: '88888888-8888-4888-8888-888888888888',
    state: 'created',
    connectionId: '66666666-6666-4666-8666-666666666666',
    warehouse: { name: 'Main warehouse' },
    reason: { name: 'Defective' },
    lines: [
      { orderLineId: '33333333-3333-4333-8333-333333333333', quantity: 2 },
    ],
    requestedBy: alex,
    requestedAt: '2026-10-08T09:20:00.000Z',
    expiresAt: '2026-10-09T09:20:00.000Z',
    decidedBy: sam,
    decidedAt: '2026-10-08T09:40:00.000Z',
    decisionId: '99999999-0000-4000-8000-000000000001',
    approvalOutcome: 'approved',
    externalReturn: { externalId: '7', number: 'RE-2026-0007' },
    createdAt: '2026-10-08T09:40:02.000Z',
    failure: null,
    observeOnly: false,
    canApprove: false,
    canSend: false,
    canCheck: false,
  },
  creationAvailability: { ...open.creationAvailability, blocker: 'created' },
};

const awaitingApproval: ReturnCaseDetail = {
  ...open,
  creation: {
    ...proposed.creation!,
    state: 'approval_required',
    decidedBy: null,
    decidedAt: null,
    approvalOutcome: null,
    externalReturn: null,
    createdAt: null,
    canApprove: true,
  },
  creationAvailability: {
    ...open.creationAvailability,
    blocker: 'in_progress',
  },
};

const cancelled: ReturnCaseDetail = {
  ...open,
  case: {
    ...open.case,
    state: 'cancelled',
    stage: 'cancelled',
    cancellation: {
      by: alex,
      at: '2026-10-08T12:00:00.000Z',
      reason: 'Opened twice',
    },
  },
  creationAvailability: { ...open.creationAvailability, blocker: 'cancelled' },
};

function settlement(state: string): ReturnActionList {
  const now = new Date().toISOString();

  return {
    available: true,
    asOf: now,
    targetStatus: 'not_configured',
    targets: [],
    items: [
      {
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        caseId: proposed.case.id,
        connectionId: proposed.case.connectionId,
        orderLineId: null,
        kind: 'refund',
        plan: {
          kind: 'refund',
          order: { externalId: 'gid://shopify/Order/1', scopeKey: '' },
          lines: [
            {
              orderLine: {
                externalId: 'gid://shopify/LineItem/2',
                scopeKey: 'gid://shopify/Order/1',
              },
              quantity: 2,
            },
          ],
          amount: '48',
          currency: 'EUR',
          transactions: [
            {
              parentId: 'gid://shopify/OrderTransaction/3',
              gateway: 'shopify_payments',
              amount: '48',
            },
          ],
        },
        requestedBy: alex.id,
        requestedAt: now,
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        decidedBy: sam.id,
        decidedAt: now,
        decisionId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        state:
          state === 'stale'
            ? 'verified'
            : state === 'approval'
              ? 'approval_required'
              : state === 'failed'
                ? 'failed'
                : 'pending',
        sent: state !== 'approval',
        failure: null,
        updatedAt: now,
        proof:
          state === 'approval'
            ? null
            : {
                outcome:
                  state === 'stale'
                    ? 'passed'
                    : state === 'failed'
                      ? 'failed'
                      : 'inconclusive',
                payment:
                  state === 'stale'
                    ? 'paid'
                    : state === 'failed'
                      ? 'failed'
                      : 'pending',
                observedAt: state === 'stale' ? '2026-09-01T00:00:00Z' : now,
                evidenceRefs: ['eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'],
              },
        canApprove: state === 'approval',
        canCheck: state !== 'approval',
        canSend: false,
        observeOnly: false,
      },
    ],
  };
}

const details: Record<string, ReturnCaseDetail> = {
  open,
  proposed,
  approval: awaitingApproval,
  shopifyApproval: {
    ...awaitingApproval,
    order: {
      ...open.order,
      connection: {
        ...open.order.connection,
        label: 'Shopify',
        provider: 'shopify',
      },
    },
    sourceReturn: {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      name: '#1042-R1',
      status: 'requested',
    },
    creation: { ...awaitingApproval.creation!, operation: 'approve' },
    creationAvailability: {
      ...awaitingApproval.creationAvailability,
      connection: { id: open.order.connection.id, label: 'Shopify' },
    },
  },
  cancelled,
};

function Preview({
  state = 'open',
  evidence,
  settlementState,
}: {
  state?: string;
  evidence?: 'fresh' | 'stale' | 'loading' | 'unavailable';
  settlementState?: 'pending' | 'failed' | 'stale' | 'approval' | 'unavailable';
}) {
  const [client] = useState(() => new QueryClient());
  const [router] = useState(() =>
    createRouter({
      history: createMemoryHistory(),
      routeTree: createRootRoute({
        component: () => (
          <>
            <style>{appStyles}</style>
            <ReturnCaseView
              organizationId={org}
              detail={details[state]}
              settlementStarted={
                !!settlementState && settlementState !== 'approval'
              }
              settlement={
                settlementState ? (
                  <ReturnSettlement
                    organizationId={org}
                    detail={proposed}
                    data={
                      settlementState === 'unavailable'
                        ? undefined
                        : settlement(settlementState)
                    }
                    loading={false}
                    unavailable={settlementState === 'unavailable'}
                    retry={() => {}}
                  />
                ) : undefined
              }
              sourceDetail={
                evidence === 'fresh' || evidence === 'stale'
                  ? {
                      ...sourceDetail,
                      item: {
                        ...sourceDetail.item,
                        observedAt:
                          evidence === 'fresh'
                            ? open.asOf
                            : '2026-09-01T00:00:00Z',
                      },
                      refunds: sourceDetail.refunds.map((r) => ({
                        ...r,
                        observedAt:
                          evidence === 'fresh' ? open.asOf : r.observedAt,
                      })),
                    }
                  : undefined
              }
              sourceLoading={evidence === 'loading'}
              sourceUnavailable={evidence === 'unavailable'}
              loading={state === 'loading'}
              error={state === 'missing' ? 'missing' : undefined}
              refresh={() => {}}
              people={[
                { ...alex, detail: 'alex@example.test' },
                { ...sam, detail: 'sam@example.test' },
              ]}
            />
          </>
        ),
      }),
    }),
  );

  return (
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}

const meta = {
  title: 'Returns/Return case',
  component: Preview,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof Preview>;

export default meta;

type Story = StoryObj<typeof meta>;

export const AwaitingReceipt: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole('heading', {
        name: 'Return case for order AU-2026-1042',
      }),
    ).toBeVisible();
    // Inspection waits for a receipt; only receiving is offered.
    await expect(
      canvas.queryByRole('button', { name: 'Record inspection' }),
    ).toBeNull();
    await userEvent.click(
      canvas.getByRole('button', { name: 'Record receipt' }),
    );
    const dialog = within(await within(document.body).findByRole('dialog'));
    await expect(dialog.getAllByLabelText('Received')).toHaveLength(2);
  },
};

export const Proposed: Story = {
  args: { state: 'proposed' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByText(
        'An independent read found exactly this return in JTL-Wawi.',
      ),
    ).toBeVisible();
    await expect(canvas.getByText('Proposal: Refund')).toBeVisible();
  },
};

export const AwaitingApproval: Story = {
  args: { state: 'approval' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole('button', {
        name: 'Approve and create in JTL-Wawi',
      }),
    ).toBeVisible();
  },
};

export const Cancelled: Story = { args: { state: 'cancelled' } };

export const Dark: Story = {
  args: { state: 'proposed' },
  globals: { theme: 'dark' },
};

export const Narrow: Story = {
  args: { state: 'proposed' },
  globals: { viewport: { value: 'mobile1', isRotated: false } },
};

export const Missing: Story = { args: { state: 'missing' } };

export const Loading: Story = { args: { state: 'loading' } };

export const ShopifyApproval: Story = {
  args: { state: 'shopifyApproval' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole('heading', {
        name: 'Approve the request in Shopify',
      }),
    ).toBeVisible();
    await expect(
      canvas.getByText(/Approve the existing customer return request/),
    ).toBeVisible();
    await expect(
      canvas.getByRole('button', { name: 'Approve the return in Shopify' }),
    ).toBeVisible();
  },
};

export const SourceLoading: Story = {
  args: { evidence: 'loading' },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByText('Loading source evidence…'),
    ).toBeVisible();
  },
};

export const SourceUnavailable: Story = {
  args: { evidence: 'unavailable' },
  play: async ({ canvasElement }) => {
    await expect(
      within(
        within(canvasElement).getByRole('region', {
          name: 'What you can tell the customer',
        }),
      ).getByText(
        'Source evidence is unavailable. Financial status cannot be confirmed.',
      ),
    ).toBeVisible();
  },
};

export const StaleSource: Story = {
  args: { evidence: 'stale' },
  play: async ({ canvasElement }) => {
    const summary = within(
      within(canvasElement).getByRole('region', {
        name: 'What you can tell the customer',
      }),
    );
    await expect(summary.queryByText('Observed money returned')).toBeNull();
  },
};

export const SettlementPending: Story = {
  args: { state: 'proposed', settlementState: 'pending' },
  play: async ({ canvasElement }) => {
    const section = within(canvasElement).getByRole('region', {
      name: 'Stock and refund',
    });
    await expect(within(section).getByText('Refund processing')).toBeVisible();
    await expect(
      within(section).getByRole('button', { name: 'Check source' }),
    ).toBeVisible();
    await expect(
      within(section).queryByText('Independently verified'),
    ).not.toBeInTheDocument();
  },
};

export const SettlementFailed: Story = {
  args: { state: 'proposed', settlementState: 'failed' },
};

export const SettlementStale: Story = {
  args: { state: 'proposed', settlementState: 'stale' },
  play: async ({ canvasElement }) => {
    const section = within(
      within(canvasElement).getByRole('region', { name: 'Stock and refund' }),
    );
    await expect(
      section.queryByText('Independently verified'),
    ).not.toBeInTheDocument();
  },
};

export const SettlementApproval: Story = {
  args: { state: 'proposed', settlementState: 'approval' },
};

export const SettlementUnavailable: Story = {
  args: { state: 'proposed', settlementState: 'unavailable' },
};

export const SettlementDark: Story = {
  args: { state: 'proposed', settlementState: 'pending' },
  globals: { theme: 'dark' },
};

export const SettlementNarrow: Story = {
  args: { state: 'proposed', settlementState: 'pending' },
  globals: { viewport: { value: 'mobile1', isRotated: false } },
};
