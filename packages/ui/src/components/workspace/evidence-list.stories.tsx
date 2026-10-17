import type { EvidenceList as EvidenceListData } from '@luma/api-contract';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';

import { EvidenceList } from './evidence-list';

const now = Date.parse('2026-10-17T12:00:00Z');
const connection = {
  id: '00000000-0000-4000-8000-0000000000c1',
  label: 'JTL warehouse',
};

const evidence: EvidenceListData = {
  subject: {
    kind: 'purchase_order',
    id: '00000000-0000-4000-8000-000000000001',
  },
  truncated: false,
  asOf: '2026-10-17T12:00:00Z',
  items: [
    {
      ref: '00000000-0000-4000-8000-0000000000a1',
      citedAs: 'read',
      citedAt: '2026-10-17T11:55:00Z',
      resolution: {
        kind: 'read',
        provider: 'JTL',
        connection,
        record: { resource: 'purchase_order', externalId: 'B-1007' },
        observedAt: '2026-10-17T11:55:00Z',
        sourceUpdatedAt: '2026-10-17T11:54:30Z',
        sourceRevision: '14',
        completeness: 'complete',
        adapterVersion: 'jtl-purchasing/2',
        summary: [
          { field: 'status', value: 'open' },
          { field: 'orderNumber', value: 'B-1007' },
          { field: 'confirmed', value: 'false' },
          { field: 'lines', value: '3' },
        ],
      },
    },
    {
      ref: '00000000-0000-4000-8000-0000000000a2',
      citedAs: 'write_receipt',
      citedAt: '2026-10-17T11:54:00Z',
      resolution: {
        kind: 'write_receipt',
        provider: 'JTL',
        connection,
        capability: 'Submit purchase orders',
        acceptedAt: '2026-10-17T11:54:00Z',
        records: [{ resource: 'purchase_order', externalId: 'B-1007' }],
        providerRequestId: 'req-58c1',
        adapterVersion: 'jtl-purchasing/2',
      },
    },
    {
      ref: '00000000-0000-4000-8000-0000000000a3',
      citedAs: 'read',
      citedAt: '2026-10-17T11:50:00Z',
      resolution: {
        kind: 'read',
        provider: 'Shopify',
        connection: { ...connection, label: null },
        record: { resource: 'refund', externalId: 'gid://shopify/Refund/9' },
        observedAt: '2026-10-17T11:50:00Z',
        sourceUpdatedAt: null,
        sourceRevision: null,
        completeness: 'partial',
        adapterVersion: null,
        summary: [{ field: 'payment', value: 'pending' }],
      },
    },
    {
      ref: '00000000-0000-4000-8000-0000000000a4',
      citedAs: null,
      citedAt: null,
      resolution: {
        kind: 'luma_record',
        record: 'approval',
        id: '00000000-0000-4000-8000-0000000000a4',
      },
    },
    {
      ref: '00000000-0000-4000-8000-0000000000a5',
      citedAs: 'read',
      citedAt: '2026-09-02T08:00:00Z',
      resolution: {
        kind: 'not_retained',
        retentionStartedAt: '2026-10-01T06:00:00Z',
      },
    },
    {
      ref: '00000000-0000-4000-8000-0000000000a6',
      citedAs: 'read',
      citedAt: '2026-10-17T11:56:00Z',
      resolution: { kind: 'unresolved' },
    },
    {
      ref: 'procurement-follow-up-recorded/1',
      citedAs: null,
      citedAt: null,
      resolution: { kind: 'unresolved' },
    },
  ],
};

const meta = {
  title: 'Workspace/Evidence list',
  component: EvidenceList,
  args: { state: { status: 'ready', evidence }, now },
  decorators: [
    (Story) => (
      <div style={{ maxWidth: 560, padding: 16 }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof EvidenceList>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Resolved: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const list = canvas.getByRole('list', { name: 'Cited evidence' });
    const entries = within(list).getAllByRole('listitem');
    expect(entries.filter((entry) => entry.dataset.kind)).toHaveLength(7);

    // Reads name the system, freshness and completeness in text.
    expect(
      canvas.getByText('Read from JTL, JTL warehouse'),
    ).toBeInTheDocument();
    expect(canvas.getByText('Complete')).toBeInTheDocument();
    expect(canvas.getByText(/5 minutes ago/)).toBeInTheDocument();
    expect(canvas.getByText('Order number')).toBeInTheDocument();
    expect(canvas.getAllByText('No').length).toBeGreaterThan(0);

    // A partial read says it can't establish the outcome; a removed connection is named so.
    expect(
      canvas.getByText(/Partial: this read can't establish the outcome/),
    ).toBeInTheDocument();
    expect(
      canvas.getByText('Read from Shopify, a removed connection'),
    ).toBeInTheDocument();

    // A receipt is acceptance, not verification.
    expect(
      canvas.getByText('Accepted by JTL, JTL warehouse'),
    ).toBeInTheDocument();
    expect(canvas.getByText('req-58c1')).toBeInTheDocument();
    // The read and the receipt each name the adapter version that produced them.
    expect(canvas.getAllByText('jtl-purchasing/2')).toHaveLength(2);
    expect(
      canvas.getByText(/Only a later read confirms the outcome/),
    ).toBeInTheDocument();

    expect(canvas.getByText('Approval')).toBeInTheDocument();
    expect(
      canvas.getByText('Recorded before Luma kept evidence'),
    ).toBeInTheDocument();
    expect(canvas.getByText('Not retained')).toBeInTheDocument();
    expect(canvas.getByText('No stored evidence found')).toBeInTheDocument();
    expect(
      canvas.getByText(/Treat the outcome it supports as unconfirmed/),
    ).toBeInTheDocument();
    // A reference that names nothing this view shows is not presented as missing evidence.
    expect(
      canvas.getByText('Nothing to show for this reference'),
    ).toBeInTheDocument();
  },
};

export const ResolvedDark: Story = {
  globals: { theme: 'dark' },
};

export const Narrow: Story = {
  decorators: [
    (Story) => (
      <div style={{ width: 320 }}>
        <Story />
      </div>
    ),
  ],
};

export const Truncated: Story = {
  args: {
    state: {
      status: 'ready',
      evidence: {
        ...evidence,
        items: evidence.items.slice(0, 2),
        truncated: true,
      },
    },
  },
  play: async ({ canvasElement }) => {
    expect(
      within(canvasElement).getByText('Showing the first 2 references.'),
    ).toBeInTheDocument();
  },
};

export const Empty: Story = {
  args: {
    state: { status: 'ready', evidence: { ...evidence, items: [] } },
  },
  play: async ({ canvasElement }) => {
    expect(
      within(canvasElement).getByText('Nothing is cited here yet.'),
    ).toBeInTheDocument();
  },
};

export const Loading: Story = {
  args: { state: { status: 'loading' } },
  play: async ({ canvasElement }) => {
    expect(
      within(canvasElement).getByText('Loading evidence…'),
    ).toBeInTheDocument();
  },
};

export const Failed: Story = {
  args: { state: { status: 'failed', retry: fn() } },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    expect(canvas.getByRole('alert')).toHaveTextContent(
      "Luma couldn't load this evidence.",
    );
    await userEvent.click(canvas.getByRole('button', { name: 'Retry' }));
    if (args.state.status === 'failed')
      expect(args.state.retry).toHaveBeenCalledOnce();
  },
};

export const Forbidden: Story = {
  args: { state: { status: 'forbidden' } },
  play: async ({ canvasElement }) => {
    expect(
      within(canvasElement).getByText(
        "You don't have access to the evidence of this record.",
      ),
    ).toBeInTheDocument();
  },
};

const member = {
  kind: 'member' as const,
  id: '00000000-0000-4000-8000-0000000000e1',
  name: 'Mara Lind',
  email: 'mara@example.test',
  workflow: null,
};

/** Records with their time, actor and facts, a stored message and evidence the reader can't open. */
const records: EvidenceListData = {
  ...evidence,
  subject: {
    kind: 'purchasing_plan',
    id: '00000000-0000-4000-8000-000000000002',
  },
  items: [
    {
      ref: '00000000-0000-4000-8000-0000000000b1',
      citedAs: 'read',
      citedAt: '2026-10-17T11:40:00Z',
      resolution: {
        kind: 'read',
        provider: 'Shopify',
        connection: { ...connection, label: 'Shopify store' },
        record: {
          resource: 'sku',
          externalId: 'gid://shopify/InventoryLevel/1',
        },
        observedAt: '2026-10-17T11:40:00Z',
        sourceUpdatedAt: '2026-10-17T11:39:00Z',
        sourceRevision: null,
        completeness: null,
        adapterVersion: 'shopify-inventory/3',
        summary: [
          { field: 'available', value: '4' },
          { field: 'reserved', value: '1' },
        ],
      },
    },
    {
      ref: '00000000-0000-4000-8000-0000000000b2',
      citedAs: 'read',
      citedAt: '2026-10-17T11:58:00Z',
      resolution: {
        kind: 'luma_record',
        record: 'procurement_event',
        id: '00000000-0000-4000-8000-0000000000b2',
        at: '2026-10-17T11:58:00Z',
        actor: member,
        detail: {
          kind: 'procurement_event',
          event: 'status_changed',
          from: 'draft',
          to: 'open',
          revision: 2,
        },
      },
    },
    {
      ref: '00000000-0000-4000-8000-0000000000b3',
      citedAs: 'record',
      citedAt: '2026-10-17T11:30:00Z',
      resolution: {
        kind: 'luma_record',
        record: 'stock_receipt_review',
        id: '00000000-0000-4000-8000-0000000000b3',
        at: '2026-10-17T11:30:00Z',
        actor: { ...member, kind: 'former_member', email: null },
        detail: {
          kind: 'stock_receipt_review',
          state: 'approved',
          quantity: '24',
          unit: 'each',
        },
      },
    },
    {
      ref: '00000000-0000-4000-8000-0000000000b4',
      citedAs: 'record',
      citedAt: '2026-10-17T11:31:00Z',
      resolution: {
        kind: 'luma_record',
        record: 'ledger_entry',
        id: '00000000-0000-4000-8000-0000000000b4',
        at: '2026-10-17T11:31:00Z',
        actor: member,
        detail: {
          kind: 'ledger_entry',
          purpose: 'purchase_receipt',
          reversed: false,
          postings: [
            {
              state: 'available',
              unit: 'each',
              quantity: '24',
              balanceAfter: '30',
              version: 7,
            },
            {
              state: 'supplier',
              unit: 'each',
              quantity: '-24',
              balanceAfter: '-24',
              version: 3,
            },
          ],
        },
      },
    },
    {
      ref: '00000000-0000-4000-8000-0000000000b5',
      citedAs: null,
      citedAt: null,
      resolution: {
        kind: 'message',
        provider: 'gmail',
        connection: { ...connection, label: 'Purchasing inbox' },
        direction: 'outbound',
        sender: { address: 'buying@shop.example', name: 'Shop buying' },
        receivedAt: '2026-10-17T10:00:00Z',
        subject: 'Purchase order PO-2026-118',
        senderAuthentication: 'aligned',
      },
    },
    {
      ref: '00000000-0000-4000-8000-0000000000b6',
      citedAs: null,
      citedAt: null,
      resolution: {
        kind: 'message',
        provider: 'gmail',
        connection: { ...connection, label: null },
        direction: 'inbound',
        sender: { address: 'orders@supplier.example', name: null },
        receivedAt: '2026-10-17T10:30:00Z',
        subject: '',
        senderAuthentication: 'unaligned',
      },
    },
    {
      ref: '00000000-0000-4000-8000-0000000000b7',
      citedAs: 'read',
      citedAt: '2026-10-17T11:40:00Z',
      resolution: { kind: 'restricted', permission: 'orders.read' },
    },
    {
      ref: 'Delivery note 4471',
      citedAs: null,
      citedAt: null,
      resolution: {
        kind: 'luma_record',
        record: 'receipt_note',
        id: '00000000-0000-4000-8000-0000000000b8',
      },
    },
  ],
};

const valueNames: Record<string, string> = {
  draft: 'Draft',
  open: 'Open',
  available: 'Available',
  supplier: 'At supplier',
  purchase_receipt: 'Purchase receipt',
};

const recordsArgs = {
  state: { status: 'ready', evidence: records },
  now,
  permissionName: (permission: string) =>
    permission === 'orders.read' ? 'View orders' : permission,
  valueName: (_kind: string, value: string) => valueNames[value] ?? value,
} as const;

export const Records: Story = {
  args: recordsArgs,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // A stock read the plan relied on.
    expect(
      canvas.getByText('Read from Shopify, Shopify store'),
    ).toBeInTheDocument();
    expect(canvas.getByText('Reserved')).toBeInTheDocument();

    // A lifecycle event names its change, when and who.
    expect(canvas.getByText('Purchase order event')).toBeInTheDocument();
    expect(canvas.getByText('Draft → Open')).toBeInTheDocument();
    expect(
      canvas.getAllByText('Mara Lind · mara@example.test').length,
    ).toBeGreaterThan(0);

    // Native receipt review and the ledger entry that booked it, with its postings.
    expect(canvas.getByText('Stock receipt review')).toBeInTheDocument();
    expect(canvas.getByText('24 each')).toBeInTheDocument();
    expect(
      canvas.getByText('Available: +24 each, balance 30 (version 7)'),
    ).toBeInTheDocument();
    expect(
      canvas.getByText('At supplier: -24 each, balance -24 (version 3)'),
    ).toBeInTheDocument();

    // Messages show who sent them and whether that is authenticated, never their text.
    expect(
      canvas.getByText('Message sent from Purchasing inbox'),
    ).toBeInTheDocument();
    expect(
      canvas.getByText('Shop buying <buying@shop.example>'),
    ).toBeInTheDocument();
    expect(
      canvas.getByText('No: anyone could have sent this message'),
    ).toBeInTheDocument();
    expect(canvas.getByText('(no subject)')).toBeInTheDocument();

    // Evidence another area guards is named, not dropped.
    expect(canvas.getByText('No access')).toBeInTheDocument();
    expect(canvas.getByText(/Someone with “View orders”/)).toBeInTheDocument();

    expect(
      canvas.getByText('Note recorded with a receipt'),
    ).toBeInTheDocument();
    expect(canvas.getByText('Delivery note 4471')).toBeInTheDocument();
  },
};

export const RecordsDark: Story = {
  args: recordsArgs,
  globals: { theme: 'dark' },
};

export const RecordsNarrow: Story = {
  args: recordsArgs,
  decorators: [
    (Story) => (
      <div style={{ width: 320 }}>
        <Story />
      </div>
    ),
  ],
};

export const NotFound: Story = {
  args: { state: { status: 'not_found' } },
};

export const Unavailable: Story = {
  args: { state: { status: 'unavailable' } },
};
