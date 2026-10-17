import type {
  DecisionItem,
  DecisionList,
  EvidenceList,
} from '@luma/api-contract';
import { Button } from '@luma/ui/components/primitives/button';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { useState } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';

import { groupId } from '../../kit/collections/groups';
import { evidenceOptions } from '../../shared/evidence/evidence';
import appStyles from '../../styles.css?inline';
import type { NeedsYouSearch } from './data';
import { DecisionInspector, type Member } from './inspector';
import {
  decisionGroupLabel,
  type NeedsYouGrouping,
  NeedsYouView,
} from './page';

const org = '33333333-3333-4333-8333-333333333333';
const alex = '44444444-4444-4444-8444-444444444444';
const sam = '55555555-5555-4555-8555-555555555555';
const now = Date.parse('2026-09-30T09:00:00.000Z');
const members: Member[] = [
  { userId: alex, name: 'Alex Morgan' },
  { userId: sam, name: 'Sam Rivera' },
];

const base = {
  consequences: [],
  change: [],
  impact: { level: 'unknown' as const, text: null },
  urgency: 'normal' as const,
  deadline: null,
  requesterId: null,
  evidence: {
    observedAt: '2026-09-30T08:55:00.000Z',
    validUntil: '2026-09-30T09:05:00.000Z',
    state: 'fresh' as const,
  },
  assignment: null,
  record: null,
};

const replenishment: DecisionItem = {
  ...base,
  id: 'replenishment:0b8c4e0a-5f7a-4d53-a2b5-5c6d7e8f9a0b',
  kind: 'replenishment',
  reason: 'approval',
  domain: 'procurement',
  title: 'Approve purchase-order draft for 50 × LAMP-01',
  why: 'Each replenishment proposal needs someone who can manage procurement, other than the rule’s principal, to approve it before Luma creates the draft. The quantity is above the rule’s 20-unit limit, so it is high risk.',
  consequences: [
    {
      response: 'Approve',
      text: 'Luma checks stock, open orders and the supplier again, then creates a purchase-order draft and verifies it with a fresh read. Nothing is sent to the supplier.',
    },
    {
      response: 'Reject',
      text: 'No order is created and the run ends. Stock stays below its minimum until the next check.',
    },
  ],
  change: [
    { label: 'SKU', value: 'LAMP-01' },
    { label: 'Supplier', value: 'Northstar Supply' },
    { label: 'Quantity', value: '50 each' },
    { label: 'Available', value: '4 each' },
    { label: 'Minimum', value: '14 each' },
    { label: 'Result', value: 'Purchase-order draft, not sent' },
  ],
  impact: {
    level: 'high',
    text: '4 each available, below the minimum of 14',
  },
  urgency: 'expiring',
  requestedAt: '2026-09-30T08:58:05.000Z',
  deadline: '2026-09-30T09:03:00.000Z',
  requesterId: sam,
  response: 'decide',
  subject: { label: 'Stock of LAMP-01', detail: 'Supplier Northstar Supply' },
  record: { kind: 'position', id: '2c1d0e9f-8a7b-4c6d-9e5f-4a3b2c1d0e9f' },
  owner: {
    kind: 'workflow_run',
    definitionId: 'inventory-replenishment',
    runId: '0b8c4e0a-5f7a-4d53-a2b5-5c6d7e8f9a0b',
  },
  group: {
    key: 'replenishment:approval',
    label: 'Purchase-order drafts awaiting approval',
  },
};

const correction: DecisionItem = {
  ...base,
  id: 'shopify:inventory_correction:7a1b',
  kind: 'inventory_correction',
  reason: 'approval',
  domain: 'inventory',
  title: 'Correct Shopify stock at Berlin warehouse',
  why: 'Changing Shopify needs someone else who can approve changes to approve this exact action before the requester can run it.',
  change: [
    { label: 'Location', value: 'Berlin warehouse' },
    { label: 'Shopify now', value: '12 units' },
    { label: 'JTL-Wawi (authority)', value: '4 units' },
    { label: 'Change', value: 'Set to 4 (-8)' },
  ],
  impact: { level: 'unknown', text: '8 units differ from JTL-Wawi' },
  urgency: 'expiring',
  requestedAt: '2026-09-30T08:57:00.000Z',
  deadline: '2026-09-30T09:02:00.000Z',
  requesterId: alex,
  response: 'awaiting_other',
  assignment: {
    assigneeId: alex,
    assignedBy: alex,
    assignedAt: '2026-09-30T08:57:30.000Z',
    revision: 1,
  },
  subject: {
    label: 'Shopify stock at Berlin warehouse',
    detail: 'Authority: JTL-Wawi',
  },
  owner: {
    kind: 'app_inventory',
    appId: 'shopify',
    positionId: '2c1d0e9f-8a7b-4c6d-9e5f-4a3b2c1d0e9f',
  },
  citedEvidence: {
    subject: {
      kind: 'app_decision',
      id: '6d5c4b3a-2f1e-4d0c-9b8a-7f6e5d4c3b2a',
    },
  },
  group: {
    key: 'shopify:inventory_correction:approval',
    label: 'Stock corrections awaiting approval',
  },
};

const recovery: DecisionItem = {
  ...base,
  id: 'shopify:fulfillment_recovery:9c2d',
  kind: 'fulfillment_recovery',
  reason: 'recovery',
  domain: 'fulfillment',
  title: 'Release fulfillment hold at Tokyo warehouse',
  why: 'Shopify accepted this change, but no fresh read has confirmed the result yet. An accepted change is not a verified one.',
  consequences: [
    {
      response: 'Check',
      text: 'Luma reads Shopify again. Only fewer unfulfilled items on the same lines count as progress.',
    },
  ],
  change: [
    { label: 'Action', value: 'Release hold' },
    { label: 'Shopify order', value: '1042' },
    { label: 'Hold reason', value: 'Incorrect address' },
    { label: 'Unfulfilled', value: '2 units of 2 on 1 line' },
  ],
  impact: { level: 'unknown', text: '2 units not yet fulfilled' },
  requestedAt: '2026-09-30T07:40:00.000Z',
  evidence: {
    observedAt: '2026-09-30T07:40:00.000Z',
    validUntil: '2026-09-30T07:50:00.000Z',
    state: 'stale',
  },
  response: 'check',
  subject: {
    label: 'Fulfillment at Tokyo warehouse',
    detail: 'Shopify order 1042',
  },
  owner: {
    kind: 'app_fulfillment',
    appId: 'shopify',
    connectionId: '66666666-6666-4666-8666-666666666666',
    orderId: 'gid://shopify/Order/1042',
    fulfillmentId: 'gid://shopify/FulfillmentOrder/1042',
  },
  group: {
    key: 'shopify:fulfillment_recovery:recovery',
    label: 'Fulfillment recoveries to check',
  },
};

const manual: DecisionItem = {
  ...base,
  id: 'case:6f1c7a52-0f6d-4d0e-9f0b-3a4a5e0f1a2b',
  kind: 'case',
  reason: 'manual_intervention',
  domain: 'inventory',
  title: 'Stock mismatch needs a manual step',
  why: 'Correct the available quantity for LAMP-02 in JTL-Wawi; Shopify follows the ERP.',
  consequences: [
    {
      response: 'Resolve',
      text: 'Take the step in the source system. Luma closes the issue only after a fresh read no longer shows the problem.',
    },
    {
      response: 'Escalate',
      text: 'No action runs. The issue stays open and is marked for investigation.',
    },
  ],
  change: [
    { label: 'Issue', value: 'Stock mismatch' },
    { label: 'Affected', value: 'SKU LAMP-02' },
    { label: 'Exposed', value: '6 each exposed' },
  ],
  impact: { level: 'medium', text: '6 each exposed' },
  requestedAt: '2026-09-30T06:10:00.000Z',
  response: 'investigate',
  subject: {
    label: 'SKU LAMP-02',
    detail: 'Shopify shows 6 more units than JTL-Wawi.',
  },
  owner: {
    kind: 'case',
    exceptionId: '6f1c7a52-0f6d-4d0e-9f0b-3a4a5e0f1a2b',
  },
  group: {
    key: 'case:inventory_mismatch:manual_intervention',
    label: 'Stock mismatch: manual steps',
  },
};

/** A return case cites one of several records; here its latest step, a refund. */
const returnCase: DecisionItem = {
  ...base,
  id: 'return-case:1b0f8a4e-2c3d-4e5f-8a9b-0c1d2e3f4a5b',
  kind: 'return_case',
  reason: 'manual_intervention',
  domain: 'orders',
  title: '#1001',
  why: 'The return needs receipt, inspection or settlement by its owner.',
  change: [
    { label: 'Units', value: '2' },
    { label: 'Stage', value: 'received' },
  ],
  requestedAt: '2026-09-30T07:00:00.000Z',
  evidence: {
    observedAt: '2026-09-30T08:40:00.000Z',
    validUntil: null,
    state: 'fresh',
  },
  response: 'investigate',
  subject: { label: '#1001', detail: null },
  owner: {
    kind: 'return_case',
    caseId: '1b0f8a4e-2c3d-4e5f-8a9b-0c1d2e3f4a5b',
  },
  citedEvidence: {
    subject: {
      kind: 'return_settlement',
      id: '5f4b2e8c-6071-4293-8e3f-4a5b6c7d8e9f',
    },
    covers: 'refund_step',
  },
  group: { key: 'return-cases', label: 'Returns' },
};

const list: DecisionList = {
  schemaVersion: 1,
  asOf: '2026-09-30T09:00:00.000Z',
  items: [replenishment, correction, recovery, manual, returnCase],
  nextCursor: null,
  totalCount: 5,
  offset: 0,
  counts: {
    views: { all: 5, mine: 1, unassigned: 4 },
    domains: {
      orders: 1,
      fulfillment: 1,
      inventory: 2,
      procurement: 1,
      operations: 0,
    },
    reasons: {
      approval: 2,
      run: 0,
      recovery: 1,
      manual_intervention: 2,
      uncertainty: 0,
    },
  },
  sources: [
    { id: 'cases', label: 'Issues', state: 'available' },
    { id: 'return-cases', label: 'Returns', state: 'available' },
    { id: 'replenishment', label: 'Replenishment', state: 'available' },
    { id: 'app:shopify', label: 'Shopify', state: 'available' },
  ],
};

/** What the stock correction cites: the Shopify read its preconditions rest on. */
const correctionEvidence: EvidenceList = {
  subject: {
    kind: 'app_decision',
    id: '6d5c4b3a-2f1e-4d0c-9b8a-7f6e5d4c3b2a',
  },
  truncated: false,
  asOf: '2026-09-30T09:00:00.000Z',
  items: [
    {
      ref: '7e6d5c4b-3a2f-4e1d-8c0b-9a8f7e6d5c4b',
      citedAs: 'read',
      citedAt: '2026-09-30T08:57:00.000Z',
      resolution: {
        kind: 'read',
        provider: 'shopify',
        connection: {
          id: '8f7e6d5c-4b3a-4f2e-9d1c-0b9a8f7e6d5c',
          label: 'Berlin store',
        },
        record: {
          resource: 'inventory_level',
          externalId: 'gid://shopify/InventoryLevel/1',
        },
        observedAt: '2026-09-30T08:56:30.000Z',
        sourceUpdatedAt: null,
        sourceRevision: null,
        completeness: 'complete',
        adapterVersion: 'shopify-inventory/3',
        summary: [{ field: 'available', value: '12' }],
      },
    },
    {
      ref: '6d5c4b3a-2f1e-4d0c-9b8a-7f6e5d4c3b2a',
      citedAs: 'record',
      citedAt: '2026-09-30T08:57:00.000Z',
      resolution: {
        kind: 'luma_record',
        record: 'case_proposal',
        id: '6d5c4b3a-2f1e-4d0c-9b8a-7f6e5d4c3b2a',
      },
    },
  ],
};

/** What the refund step cites: the payment read its proof rests on and Shopify's receipt. */
const refundEvidence: EvidenceList = {
  subject: returnCase.citedEvidence!.subject,
  truncated: false,
  asOf: '2026-09-30T09:00:00.000Z',
  items: [
    {
      ref: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d',
      citedAs: 'write_receipt',
      citedAt: '2026-09-30T08:30:00.000Z',
      resolution: {
        kind: 'write_receipt',
        provider: 'shopify',
        connection: {
          id: '8f7e6d5c-4b3a-4f2e-9d1c-0b9a8f7e6d5c',
          label: 'Berlin store',
        },
        capability: 'returns.refund',
        acceptedAt: '2026-09-30T08:30:00.000Z',
        records: [{ resource: 'refund', externalId: 'gid://shopify/Refund/7' }],
        providerRequestId: null,
        adapterVersion: 'shopify-returns/2',
      },
    },
    {
      ref: '0b9a8f7e-6d5c-4b3a-9f2e-1d0c9b8a7f6e',
      citedAs: 'read',
      citedAt: '2026-09-30T08:40:00.000Z',
      resolution: {
        kind: 'read',
        provider: 'shopify',
        connection: {
          id: '8f7e6d5c-4b3a-4f2e-9d1c-0b9a8f7e6d5c',
          label: 'Berlin store',
        },
        record: { resource: 'order', externalId: 'gid://shopify/Order/1001' },
        observedAt: '2026-09-30T08:40:00.000Z',
        sourceUpdatedAt: null,
        sourceRevision: null,
        completeness: 'complete',
        adapterVersion: 'shopify-returns/2',
        summary: [{ field: 'payment', value: 'paid' }],
      },
    },
  ],
};

const review = (
  <div className="replenishment-review">
    <p>The owner’s review renders here with Approve and Reject.</p>
    <Button variant="outline">Reject proposal</Button>{' '}
    <Button>Approve 50 units</Button>
  </div>
);

function Content({
  state,
  initial,
}: {
  state: string;
  initial: NeedsYouSearch;
}) {
  const [search, setSearch] = useState<NeedsYouSearch>(initial);
  const shown =
    state === 'loading' || state === 'error'
      ? undefined
      : state === 'empty' || state === 'answered'
        ? {
            ...list,
            items: [],
            totalCount: 0,
            counts: {
              ...list.counts,
              views: { all: 0, mine: 0, unassigned: 0 },
            },
          }
        : state === 'partial'
          ? {
              ...list,
              sources: list.sources.map((source) =>
                source.id === 'app:shopify'
                  ? { ...source, state: 'unavailable' as const }
                  : source,
              ),
            }
          : list;
  const item: DecisionItem | undefined =
    state === 'answered' && search.item
      ? {
          ...replenishment,
          response: 'view_only',
          assignment: null,
          outcome: {
            state: 'approved',
            at: '2026-09-30T08:59:00.000Z',
            actorId: alex,
            actorName: 'Alex Morgan',
            actorEmail: 'alex@example.test',
            next: 'verified',
            workflow: true,
            purchaseOrderId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            runId: '0b8c4e0a-5f7a-4d53-a2b5-5c6d7e8f9a0b',
            definitionId: 'inventory-replenishment',
          },
        }
      : shown?.items.find((entry) => entry.id === search.item);
  // Grouped by cause, as the queue's server groups would return them.
  const causes = [...new Set(list.items.map((entry) => entry.group.key))];
  const grouped: NeedsYouGrouping | undefined =
    search.group === 'cause'
      ? {
          grouping: { field: 'cause', showEmpty: false },
          groups: causes.map((key) => {
            const rows = list.items.filter((entry) => entry.group.key === key);

            return {
              id: groupId(key),
              group: {
                key,
                count: rows.length,
                complete: true,
                itemIds: rows.map((entry) => entry.id),
                nextCursor: null,
                sums: [],
              },
              rows,
              more: undefined,
            };
          }),
          label: (key) =>
            decisionGroupLabel('cause', key, {
              items: list.items,
              members,
              self: alex,
            }),
          collapsed: [],
          onCollapsedChange: () => {},
        }
      : undefined;

  return (
    <NeedsYouView
      organizationId={org}
      search={search}
      grouped={grouped}
      list={shown}
      loading={state === 'loading'}
      error={state === 'error' ? 'Try Refresh.' : undefined}
      offline={state === 'offline'}
      onNext={() => {}}
      onChange={setSearch}
      onRefresh={() => {}}
      now={now}
      members={members}
      self={alex}
      selected={search.item ? (item ?? 'missing') : undefined}
      inspector={
        item ? (
          <DecisionInspector
            organizationId={org}
            item={item}
            members={members}
            self={alex}
            assignmentAccess="anyone"
            now={now}
            onClose={() => setSearch({ ...search, item: undefined })}
            onAssign={() => {}}
            review={item.outcome ? null : review}
          />
        ) : null
      }
    />
  );
}

function Preview({
  state = 'list',
  initial = {},
}: {
  state?: string;
  initial?: NeedsYouSearch;
}) {
  const [router] = useState(() =>
    createRouter({
      history: createMemoryHistory(),
      routeTree: createRootRoute({
        component: () => (
          <>
            <style>{appStyles}</style>
            <Content state={state} initial={initial} />
          </>
        ),
      }),
    }),
  );
  // Evidence loads only when opened; the story answers it from this cache.
  const [client] = useState(() => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(
      evidenceOptions(org, correctionEvidence.subject).queryKey,
      correctionEvidence,
    );
    queryClient.setQueryData(
      evidenceOptions(org, refundEvidence.subject).queryKey,
      refundEvidence,
    );

    return queryClient;
  });

  return (
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}

const meta = {
  title: 'Needs you/Queue',
  component: Preview,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof Preview>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Queue: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByText('Approve purchase-order draft for 50 × LAMP-01'),
    ).toBeVisible();
    await expect(canvas.getByText('3m left')).toBeVisible();
    await expect(
      canvas.getByText('Waiting for another approver'),
    ).toBeVisible();
    await expect(canvas.getByText('Check the outcome')).toBeVisible();
  },
};

export const Selected: Story = {
  args: { initial: { item: replenishment.id } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole('heading', { name: 'Why you’re needed' }),
    ).toBeVisible();
    await expect(
      canvas.queryByText('Purchase-order draft, not sent'),
    ).not.toBeInTheDocument();
    await expect(canvas.getByRole('button', { name: 'Take it' })).toBeEnabled();
    await userEvent.click(canvas.getByRole('combobox', { name: 'Assign to…' }));
    const people = await within(document.body).findByRole('listbox', {
      name: 'Assign to a member',
    });
    const [first, second] = within(people).getAllByRole('option');
    await expect(first).toHaveTextContent('YouAlex Morgan');
    await expect(second).toHaveTextContent('Sam Rivera');
    // Escape closes only the picker, even before focus reaches its search field.
    canvas.getByRole('combobox', { name: 'Assign to…' }).focus();
    await userEvent.keyboard('{Escape}');
    await waitFor(() =>
      expect(within(document.body).queryByRole('listbox')).toBeNull(),
    );
    await expect(
      canvas.getByRole('heading', { name: 'Why you’re needed' }),
    ).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Close panel' }));
    await waitFor(() =>
      expect(
        canvas.queryByRole('heading', { name: 'Why you’re needed' }),
      ).toBeNull(),
    );
  },
};

export const SelectedEvidence: Story = {
  args: { initial: { item: correction.id } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const summary = await canvas.findByText('What this decision cites');
    // Closed until asked for: nothing is read while the reader only scans the decision.
    await expect(
      canvas.queryByRole('list', { name: 'Cited evidence' }),
    ).not.toBeInTheDocument();
    await userEvent.click(summary);
    const evidence = await canvas.findByRole('list', {
      name: 'Cited evidence',
    });
    await expect(
      within(evidence).getByText('Provider read', { exact: true }),
    ).toBeVisible();
    await expect(within(evidence).getByText('Proposed change')).toBeVisible();
  },
};

export const SelectedEvidenceNarrow: Story = {
  ...SelectedEvidence,
  globals: { viewport: { value: 'mobile1', isRotated: false } },
};

/** A return case names the record it cites, here its latest refund, instead of the case. */
export const SelectedReturnEvidence: Story = {
  args: { initial: { item: returnCase.id } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const summary = await canvas.findByText('Evidence: refund step');
    await expect(
      canvas.queryByText('What this decision cites'),
    ).not.toBeInTheDocument();
    await userEvent.click(summary);
    const evidence = await canvas.findByRole('list', {
      name: 'Cited evidence',
    });
    await expect(
      within(evidence).getByText('Write receipt', { exact: true }),
    ).toBeVisible();
    await expect(
      within(evidence).getByText('Provider read', { exact: true }),
    ).toBeVisible();
  },
};

export const SelectedReturnEvidenceNarrow: Story = {
  ...SelectedReturnEvidence,
  globals: { viewport: { value: 'mobile1', isRotated: false } },
};

export const SelectedDark: Story = {
  args: { initial: { item: recovery.id } },
  globals: { theme: 'dark' },
};

export const SelectedNarrow: Story = {
  args: { initial: { item: manual.id } },
  globals: { viewport: { value: 'mobile1', isRotated: false } },
};

export const Grouped: Story = {
  args: { initial: { group: 'cause' } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole('heading', {
        name: /Stock corrections awaiting approval/,
      }),
    ).toBeVisible();
    await expect(canvas.getByText(/nothing is approved in bulk/)).toBeVisible();
  },
};

export const Dark: Story = { globals: { theme: 'dark' } };

export const Narrow: Story = {
  globals: { viewport: { value: 'mobile1', isRotated: false } },
};

export const Empty: Story = { args: { state: 'empty' } };

export const SourceUnavailable: Story = { args: { state: 'partial' } };

export const Loading: Story = { args: { state: 'loading' } };

export const Error: Story = { args: { state: 'error' } };

export const Offline: Story = { args: { state: 'offline' } };

export const Answered: Story = {
  args: { state: 'answered', initial: { item: replenishment.id } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect((await canvas.findAllByText('Approved'))[0]!).toBeVisible();
    await expect(canvas.getByText('You answered this at')).toBeVisible();
    await expect(canvas.getByText('30 Sept 2026 08:59 UTC')).toBeVisible();
    await expect(
      canvas.getByRole('link', { name: /Open purchase order/ }),
    ).toHaveAttribute(
      'href',
      expect.stringContaining('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
    );
    await expect(
      canvas.getByRole('link', { name: /Open workflow run/ }),
    ).toHaveAttribute('href', expect.stringContaining('run-0b8c4e0a'));
    await expect(
      canvas.queryByRole('button', { name: 'Take it' }),
    ).not.toBeInTheDocument();
    await expect(
      canvas.queryByRole('button', { name: 'Approve 50 units' }),
    ).not.toBeInTheDocument();
  },
};

export const AnsweredDark: Story = { ...Answered, globals: { theme: 'dark' } };

export const AnsweredNarrow: Story = {
  ...Answered,
  globals: { viewport: { value: 'mobile1', isRotated: false } },
};
