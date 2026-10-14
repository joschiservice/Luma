import type { CollectionGrouping, PurchaseOrderList } from '@luma/api-contract';
import { Card, CardContent } from '@luma/ui/components/primitives/card';
import type { DataTableSort } from '@luma/ui/components/primitives/data-table';
import { Empty } from '@luma/ui/components/primitives/empty';
import type { Meta, StoryObj } from '@storybook/react-vite';
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { useState } from 'react';
import { expect, userEvent, within } from 'storybook/test';

import { CollectionNotices } from '../../kit/collections/notices';
import appStyles from '../../styles.css?inline';
import { purchaseOrderGroupLabel } from './collection';
import type { ListedPurchaseOrder } from './fields';
import { PurchaseOrderPreview } from './order-preview';
import { PurchaseOrderResults } from './order-results';

const tenantId = '33333333-3333-4333-8333-333333333333';
const northstar = '44444444-4444-4444-8444-444444444444';
const harbor = '55555555-5555-4555-8555-555555555555';
const berlin = '66666666-6666-4666-8666-666666666666';

const order = (
  index: number,
  overrides: Partial<ListedPurchaseOrder> = {},
  summary: Partial<ListedPurchaseOrder['summary']> = {},
): ListedPurchaseOrder => {
  const id = `77777777-7777-4777-8777-${String(index).padStart(12, '0')}`;

  return {
    id,
    tenantId,
    supplierId: northstar,
    supplierName: 'Northstar Supply',
    reference: `PO-2026-${String(index).padStart(3, '0')}`,
    authority: 'luma',
    externalReferences: [],
    origin: {},
    status: 'open',
    revision: 2,
    createdAt: `2026-09-${String(10 + index).padStart(2, '0')}T08:00:00.000Z`,
    updatedAt: `2026-09-${String(12 + index).padStart(2, '0')}T08:00:00.000Z`,
    lines: [
      {
        id: `88888888-8888-4888-8888-${String(index).padStart(12, '0')}`,
        sku: 'TOTE-NAT',
        description: 'Organic cotton tote · Natural',
        quantity: 120,
        unit: 'pcs',
        unitPrice: { amount: '4.20', currency: 'EUR' },
        locationId: berlin,
      },
    ],
    ...overrides,
    summary: {
      id,
      stage: 'awaiting_confirmation',
      expectedDate: '2026-10-20',
      attention: 0,
      attentionKinds: [],
      overdue: false,
      nextOwner: 'supplier',
      externalOrderNumber: null,
      confirmationDueAt: '2026-10-15T10:00:00.000Z',
      nextCheckAt: null,
      value: { amount: '504.00', currency: 'EUR' },
      ...summary,
    },
  };
};

const items = [
  order(
    1,
    {},
    {
      attention: 1,
      attentionKinds: ['confirmation_overdue'],
      overdue: true,
      nextOwner: 'buyer',
    },
  ),
  order(
    2,
    { supplierId: harbor, supplierName: 'Harbor Textiles' },
    {
      stage: 'confirmed',
      confirmationDueAt: null,
    },
  ),
  order(
    3,
    { status: 'draft' },
    {
      stage: 'draft',
      nextOwner: 'buyer',
      expectedDate: null,
      confirmationDueAt: null,
      value: 'unknown',
    },
  ),
];

const list: PurchaseOrderList = {
  items,
  canManage: true,
  totalCount: 3,
  counts: null,
  nextCursor: null,
  asOf: '2026-10-14T08:00:00.000Z',
};

const stageGroups: PurchaseOrderList = {
  ...list,
  groups: [
    {
      key: 'draft',
      count: 1,
      complete: true,
      itemIds: [items[2]!.id],
      nextCursor: null,
      sums: [],
    },
    {
      key: 'awaiting_confirmation',
      count: 4,
      complete: true,
      itemIds: [items[0]!.id],
      nextCursor: 'more',
      sums: [{ field: 'value', currency: 'EUR', amount: '2016.00' }],
    },
    {
      key: 'confirmed',
      count: 1,
      complete: true,
      itemIds: [items[1]!.id],
      nextCursor: null,
      sums: [{ field: 'value', currency: 'EUR', amount: '504.00' }],
    },
  ],
};

type State =
  'table' | 'list' | 'grouped' | 'board' | 'preview' | 'empty' | 'repair';

const locations = new Map([[berlin, 'Berlin warehouse']]);

function ListPreview({ state }: { state: State }) {
  const [sort, setSort] = useState<DataTableSort>({
    key: 'created',
    direction: 'desc',
  });
  const grouping: CollectionGrouping | null =
    state === 'grouped' || state === 'board'
      ? { field: 'stage', showEmpty: false }
      : null;
  // The preview pane is a card surface beside the list.
  if (state === 'preview')
    return (
      <Card>
        <CardContent>
          <PurchaseOrderPreview order={items[0]} locations={locations} />
        </CardContent>
      </Card>
    );

  return (
    <div className="procurement-page">
      {state === 'repair' ? (
        <CollectionNotices
          offline={false}
          error={{
            kind: 'invalid',
            message: 'This view uses filters the list can’t apply.',
          }}
          hasRows={false}
          retry={() => {}}
          firstPage={() => {}}
          repair={() => {}}
        />
      ) : null}
      <PurchaseOrderResults
        list={
          state === 'empty'
            ? { ...list, items: [] }
            : grouping
              ? stageGroups
              : list
        }
        layout={
          state === 'list' ? 'list' : state === 'board' ? 'board' : 'table'
        }
        density="comfortable"
        grouping={grouping}
        caption="All purchase orders. Sorted by: Created"
        link={(item) => <a href={`#${item.id}`} />}
        empty={
          <Empty>
            <h3>No matching purchase orders</h3>
          </Empty>
        }
        sort={sort}
        onSortChange={setSort}
        properties={['supplier', 'stage', 'expected', 'value']}
        locations={locations}
        groupLabel={(key) => purchaseOrderGroupLabel('stage', undefined, key)}
        collapsed={[]}
        onCollapsedChange={() => {}}
        more={(group) => ({
          rows: [],
          pending: false,
          failed: false,
          load: group.nextCursor ? () => {} : undefined,
        })}
      />
    </div>
  );
}

function Preview({ state = 'table' }: { state?: State }) {
  const [router] = useState(() =>
    createRouter({
      history: createMemoryHistory(),
      routeTree: createRootRoute({
        component: () => (
          <>
            <style>{appStyles}</style>
            <ListPreview state={state} />
          </>
        ),
      }),
    }),
  );

  return <RouterProvider router={router} />;
}

const meta = {
  title: 'Procurement/Purchase order list',
  component: Preview,
  parameters: { layout: 'padded' },
} satisfies Meta<typeof Preview>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Table: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole('link', { name: 'PO-2026-001' }),
    ).toBeVisible();
    await expect(canvas.getByText('Overdue')).toBeVisible();
    await expect(canvas.getByText('Mixed or partly priced')).toBeVisible();
    const created = canvas.getByRole('columnheader', { name: /Created/ });
    await userEvent.click(
      within(created).getByRole('button', { name: 'Created' }),
    );
    await expect(created).toHaveAttribute('aria-sort', 'ascending');
  },
};

export const List: Story = {
  args: { state: 'list' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole('list', { name: /All purchase orders/ }),
    ).toBeVisible();
  },
};

export const GroupedByStage: Story = {
  args: { state: 'grouped' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole('button', { name: /^Sent, waiting on supplier/ }),
    ).toBeVisible();
    await expect(canvas.getByText('Value €2,016.00')).toBeVisible();
  },
};

// Stage is derived from procurement rules, so the board never offers a move.
export const BoardByStage: Story = {
  args: { state: 'board' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole('region', { name: /Confirmed by supplier/ }),
    ).toBeVisible();
    await expect(canvas.queryByRole('button', { name: 'Move to…' })).toBeNull();
  },
};

export const BoardDark: Story = {
  args: { state: 'board' },
  globals: { theme: 'dark' },
};

export const OrderPreview: Story = {
  args: { state: 'preview' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('Confirmation overdue')).toBeVisible();
    await expect(canvas.getByText(/TOTE-NAT/)).toBeVisible();
  },
};

export const NoMatches: Story = { args: { state: 'empty' } };

export const NeedsRepair: Story = {
  args: { state: 'repair' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole('button', {
        name: 'Remove unsupported conditions',
      }),
    ).toBeVisible();
  },
};

export const Narrow: Story = {
  globals: { viewport: { value: 'mobile1', isRotated: false } },
};
