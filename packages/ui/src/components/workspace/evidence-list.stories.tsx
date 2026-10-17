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
    expect(entries.filter((entry) => entry.dataset.kind)).toHaveLength(6);

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
    expect(
      canvas.getByText(/Only a later read confirms the outcome/),
    ).toBeInTheDocument();

    expect(canvas.getByText('Approval')).toBeInTheDocument();
    expect(
      canvas.getByText('Recorded before Luma kept evidence'),
    ).toBeInTheDocument();
    expect(canvas.getByText('Not retained')).toBeInTheDocument();
    expect(canvas.getByText('No stored evidence found')).toBeInTheDocument();
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

export const NotFound: Story = {
  args: { state: { status: 'not_found' } },
};

export const Unavailable: Story = {
  args: { state: { status: 'unavailable' } },
};
