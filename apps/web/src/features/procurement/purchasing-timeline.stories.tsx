import type { EvidenceList, PurchaseOrderRecord } from '@luma/api-contract';
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

import { evidenceOptions } from '../../shared/evidence/evidence';
import appStyles from '../../styles.css?inline';
import { PurchasingTimeline } from './purchasing-timeline';

const org = '33333333-3333-4333-8333-333333333333';
const orderId = '77777777-7777-4777-8777-000000000001';
const booking = '99999999-9999-4999-8999-000000000001';
const decision = '99999999-9999-4999-8999-000000000002';
const approval = '99999999-9999-4999-8999-000000000003';
const receipt = '99999999-9999-4999-8999-000000000004';
const read = '99999999-9999-4999-8999-000000000005';
const buyer = '44444444-4444-4444-8444-444444444444';

type Entry = PurchaseOrderRecord['timeline']['entries'][number];

const entry = (
  value: Pick<Entry, 'id' | 'kind' | 'stage' | 'at' | 'source'> &
    Partial<Entry>,
): Entry => ({
  actorId: null,
  reason: null,
  evidenceRefs: [],
  quantity: null,
  unit: null,
  revision: null,
  detail: null,
  ...value,
});

/** A stock booking step as a reader without inventory access receives it: step, time and refs. */
const restricted = (
  value: Pick<Entry, 'id' | 'stage' | 'at' | 'source' | 'evidenceRefs'>,
): Entry =>
  entry({
    kind: 'stock_booking',
    restricted: { permission: 'inventory.read' },
    ...value,
  });

const timeline: PurchaseOrderRecord['timeline'] = {
  complete: true,
  entries: [
    entry({
      id: 'lifecycle:1',
      kind: 'lifecycle',
      stage: 'recorded',
      at: '2026-09-28T08:00:00.000Z',
      source: 'luma',
      actorId: buyer,
      actor: {
        kind: 'member',
        id: buyer,
        name: 'Alex Buyer',
        email: 'alex@example.test',
        workflow: null,
      },
      detail: 'draft->open',
      revision: 1,
    }),
    entry({
      id: 'commitment:1',
      kind: 'commitment',
      stage: 'recorded',
      at: '2026-09-30T07:40:00.000Z',
      source: 'manual',
      quantity: 20,
      unit: 'pcs',
      detail: 'received',
      reason: 'Delivery note: 20 physically received',
    }),
    restricted({
      id: `stock:${booking}:requested`,
      stage: 'recorded',
      at: '2026-09-30T08:00:00.000Z',
      source: 'inventory',
      evidenceRefs: [booking],
    }),
    restricted({
      id: `policy:${decision}`,
      stage: 'approval_required',
      at: '2026-09-30T08:00:01.000Z',
      source: 'luma',
      evidenceRefs: [decision, booking],
    }),
    restricted({
      id: `approval:${approval}`,
      stage: 'approved',
      at: '2026-09-30T08:20:00.000Z',
      source: 'luma',
      evidenceRefs: [approval, decision, booking],
    }),
    restricted({
      id: 'execution:1',
      stage: 'verified',
      at: '2026-09-30T08:21:00.000Z',
      source: 'inventory',
      evidenceRefs: [read, receipt],
    }),
  ],
};

/** What the evidence reader returns for the verified booking to a reader without inventory access. */
const verifiedEvidence: EvidenceList = {
  subject: { kind: 'purchase_order', id: orderId },
  truncated: false,
  asOf: '2026-09-30T09:00:00.000Z',
  items: [
    {
      ref: read,
      citedAs: 'read',
      citedAt: '2026-09-30T08:21:00.000Z',
      resolution: { kind: 'restricted', permission: 'inventory.read' },
    },
    {
      ref: receipt,
      citedAs: 'write_receipt',
      citedAt: '2026-09-30T08:21:00.000Z',
      resolution: { kind: 'restricted', permission: 'inventory.read' },
    },
  ],
};

function Preview() {
  const [router] = useState(() =>
    createRouter({
      history: createMemoryHistory(),
      routeTree: createRootRoute({
        component: () => (
          <>
            <style>{appStyles}</style>
            <PurchasingTimeline
              organizationId={org}
              orderId={orderId}
              timeline={timeline}
            />
          </>
        ),
      }),
    }),
  );
  // Evidence loads only when opened; the story answers it from this cache.
  const [client] = useState(() => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(
      evidenceOptions(org, verifiedEvidence.subject, [read, receipt]).queryKey,
      verifiedEvidence,
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
  title: 'Procurement/Purchasing timeline',
  component: Preview,
  parameters: { layout: 'padded' },
} satisfies Meta<typeof Preview>;

export default meta;

type Story = StoryObj<typeof meta>;

/** A procurement reader without inventory access sees each stock booking step, not its details. */
export const RestrictedStockBooking: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const rows = await canvas.findAllByText(
      'Details of this stock booking, such as quantities, locations and who acted, need “View inventory”.',
    );
    await expect(rows).toHaveLength(4);
    await expect(canvas.getByText('Independently verified')).toBeVisible();
    // Only the recorded receipt shows a quantity; no booking shows one or who acted.
    await expect(canvas.getAllByText(/pcs/)).toHaveLength(1);
    await expect(canvas.getAllByText(/Recorded by:/)).toHaveLength(1);
    const verified = canvas
      .getAllByRole('listitem')
      .find((item) => within(item).queryByText('Independently verified'));
    if (!verified) throw new Error('The verified booking step is missing');
    await userEvent.click(
      within(verified).getByText('Evidence (2 references)'),
    );
    await expect(
      await within(verified).findAllByText("Evidence you can't open"),
    ).toHaveLength(2);
  },
};

export const RestrictedStockBookingDark: Story = {
  globals: { theme: 'dark' },
};

export const RestrictedStockBookingNarrow: Story = {
  globals: { viewport: { value: 'mobile1', isRotated: false } },
};
