import type { DecisionItem, DecisionList } from '@luma/api-contract';
import { Button } from '@luma/ui/components/primitives/button';
import type { Meta, StoryObj } from '@storybook/react-vite';
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { useState } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';

import appStyles from '../../styles.css?inline';
import type { NeedsYouSearch } from './data';
import { DecisionInspector, type Member } from './inspector';
import { NeedsYouView } from './page';

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

const list: DecisionList = {
  schemaVersion: 1,
  asOf: '2026-09-30T09:00:00.000Z',
  items: [replenishment, correction, recovery, manual],
  nextCursor: null,
  totalCount: 4,
  offset: 0,
  counts: {
    views: { all: 4, mine: 1, unassigned: 3 },
    domains: {
      orders: 0,
      fulfillment: 1,
      inventory: 2,
      procurement: 1,
      operations: 0,
    },
    reasons: {
      approval: 2,
      run: 0,
      recovery: 1,
      manual_intervention: 1,
      uncertainty: 0,
    },
  },
  sources: [
    { id: 'cases', label: 'Issues', state: 'available' },
    { id: 'replenishment', label: 'Replenishment', state: 'available' },
    { id: 'app:shopify', label: 'Shopify', state: 'available' },
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
      : state === 'empty'
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
  const item = shown?.items.find((entry) => entry.id === search.item);

  return (
    <NeedsYouView
      organizationId={org}
      search={search}
      list={shown}
      loading={state === 'loading'}
      error={state === 'error' ? 'Try Refresh.' : undefined}
      offline={state === 'offline'}
      live={state === 'offline' ? 'interrupted' : 'live'}
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
            review={review}
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

  return <RouterProvider router={router} />;
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
    await expect(canvas.getByText('3 min left')).toBeVisible();
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
      canvas.getByText('Purchase-order draft, not sent'),
    ).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Take it' })).toBeEnabled();
    await userEvent.click(canvas.getByRole('combobox', { name: 'Assign to…' }));
    const people = await within(document.body).findByRole('listbox', {
      name: 'Assign to a member',
    });
    const [first, second] = within(people).getAllByRole('option');
    await expect(first).toHaveTextContent('YouAlex Morgan');
    await expect(second).toHaveTextContent('Sam Rivera');
    await userEvent.keyboard('{Escape}');
    await waitFor(() =>
      expect(within(document.body).queryByRole('listbox')).toBeNull(),
    );
    await userEvent.click(canvas.getByRole('button', { name: 'Close panel' }));
    await waitFor(() =>
      expect(
        canvas.queryByRole('heading', { name: 'Why you’re needed' }),
      ).toBeNull(),
    );
  },
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
  args: { initial: { grouped: true } },
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
