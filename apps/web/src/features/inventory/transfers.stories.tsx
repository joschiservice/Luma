import type { TransferDetail } from '@luma/api-contract';
import type { Meta, StoryObj } from '@storybook/react-vite';
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { useState } from 'react';
import { expect, within } from 'storybook/test';

import appStyles from '../../styles.css?inline';
import { TransferDetailView } from './transfer-detail';

const id = '11111111-1111-4111-8111-111111111111';
const connectionId = '22222222-2222-4222-8222-222222222222';
const snapshotId = '33333333-3333-4333-8333-333333333333';
const observedAt = '2026-10-12T00:00:00Z';
const detail: TransferDetail = {
  provenance: {
    observationId: snapshotId,
    sourceRevision: null,
    sourceUpdatedAt: null,
  },
  deleted: false,
  record: {
    id,
    connectionId,
    snapshotId,
    observedAt,
    label: 'Shopify · Europe',
    kind: 'inventory_shipment',
    name: 'Shipment to Berlin depot',
    status: 'partially_received',
    evidence: 'fresh',
    signals: ['rejected', 'receipt_late'],
    facts: {
      requested: '10',
      received: '8',
      shipped: '10',
      unreceived: '2',
      rejected: '1',
      expectedArrivalAt: observedAt,
      origin: null,
      destination: null,
      complete: true,
      consistent: true,
    },
  },
  data: {
    type: 'inventory_shipment',
    name: 'Shipment to Berlin depot',
    status: 'partially_received',
    createdAt: observedAt,
    shippedAt: observedAt,
    receivedAt: observedAt,
    expectedArrivalAt: observedAt,
    quantity: '10',
    receivedQuantity: '8',
    acceptedQuantity: '7',
    rejectedQuantity: '1',
    tracking: {
      carrier: 'Carrier',
      number: 'TRACK-1',
      url: 'https://example.test/TRACK-1',
    },
    lines: [
      {
        sourceId: {
          externalId: 'gid://shopify/InventoryShipmentLineItem/1',
          scopeKey: '',
        },
        sourceSku: {
          externalId: 'gid://shopify/InventoryItem/1',
          scopeKey: '',
        },
        skuId: null,
        unit: 'each',
        quantity: '10',
        accepted: '7',
        rejected: '1',
        unreceived: '2',
      },
    ],
  },
  source: { externalId: 'gid://shopify/InventoryShipment/1', scopeKey: '' },
  shipments: [],
  transfers: [],
  purchaseOrders: [],
  history: [],
  hidden: [],
  relatedTruncated: false,
  asOf: observedAt,
};

function Preview({ incomplete = false }: { incomplete?: boolean }) {
  const value: TransferDetail = incomplete
    ? {
        ...detail,
        data: detail.data ? { ...detail.data, lines: null } : null,
        record: { ...detail.record, evidence: 'incomplete', signals: [] },
      }
    : detail;
  const [router] = useState(() =>
    createRouter({
      history: createMemoryHistory(),
      routeTree: createRootRoute({
        component: () => (
          <>
            <style>{appStyles}</style>
            <main className="inventory-page">
              <TransferDetailView organizationId={id} detail={value} />
            </main>
          </>
        ),
      }),
    }),
  );

  return <RouterProvider router={router} />;
}

const meta = {
  title: 'Inventory/Transfers',
  component: Preview,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof Preview>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Receiving: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole('heading', { name: 'Exact source lines' }),
    ).toBeVisible();
    await expect(
      canvas.getByRole('button', { name: 'Download receiving evidence' }),
    ).toBeVisible();
  },
};

export const Dark: Story = { globals: { theme: 'dark' } };

export const Incomplete: Story = { args: { incomplete: true } };
