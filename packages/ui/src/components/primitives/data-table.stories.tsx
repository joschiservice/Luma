import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, userEvent, within } from 'storybook/test';

import { Badge } from './badge';
import { Card } from './card';
import {
  DataTable,
  type DataTableColumn,
  DataTableRowLink,
  type DataTableSort,
} from './data-table';
import { Empty } from './empty';

type Order = {
  id: string;
  number: string;
  status: string;
  total: number;
  source: string;
  overdue: boolean;
};

type SortKey = 'number' | 'total';

const orders: Order[] = [
  {
    id: 'a',
    number: 'SO-10',
    status: 'Open',
    total: 48,
    source: 'Tokyo store',
    overdue: true,
  },
  {
    id: 'b',
    number: '#1002',
    status: 'Completed',
    total: 1250.5,
    source: 'JTL-Wawi',
    overdue: false,
  },
  {
    id: 'c',
    number: '#1003',
    status: 'Open',
    total: 7,
    source: 'Tokyo store',
    overdue: false,
  },
];

const columns: DataTableColumn<Order, SortKey>[] = [
  {
    key: 'number',
    header: 'Order',
    sortKey: 'number',
    cell: (order) => (
      <>
        <DataTableRowLink href={`#order-${order.id}`}>
          {order.number}
        </DataTableRowLink>{' '}
        {order.overdue ? <Badge tone="danger">Overdue</Badge> : null}
      </>
    ),
  },
  { key: 'status', header: 'Status', cell: (order) => order.status },
  {
    key: 'source',
    header: 'Source',
    hideOnNarrow: true,
    cell: (order) => (
      <>
        {order.source} <a href={`#source-${order.id}`}>Source record</a>
      </>
    ),
  },
  {
    key: 'total',
    header: 'Total',
    sortKey: 'total',
    numeric: true,
    cell: (order) =>
      order.total.toLocaleString('en', { style: 'currency', currency: 'EUR' }),
  },
];

function Preview({
  rows = orders,
  density,
  variant,
}: {
  rows?: Order[];
  density?: 'default' | 'compact';
  variant?: 'framed' | 'plain';
}) {
  const [sort, setSort] = useState<DataTableSort<SortKey>>({
    key: 'number',
    direction: 'asc',
  });
  const sorted = [...rows].sort((a, b) => {
    const order =
      sort.key === 'total'
        ? a.total - b.total
        : a.number.localeCompare(b.number);

    return sort.direction === 'asc' ? order : -order;
  });

  const table = (
    <DataTable
      caption="Orders"
      columns={columns}
      rows={sorted}
      rowKey={(order) => order.id}
      sort={sort}
      onSortChange={setSort}
      density={density}
      variant={variant}
      empty={
        <Empty>
          <h2>No orders match</h2>
          <p>Try another search or filter.</p>
        </Empty>
      }
    />
  );

  return (
    <div style={{ width: 'min(720px, 100vw - 32px)' }}>
      {variant === 'plain' ? <Card>{table}</Card> : table}
    </div>
  );
}

const meta = {
  title: 'Components/Data table',
  component: Preview,
} satisfies Meta<typeof Preview>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const table = canvas.getByRole('table', { name: 'Orders' });
    const order = within(table).getByRole('columnheader', { name: /Order/ });
    const total = within(table).getByRole('columnheader', { name: /Total/ });
    await expect(order).toHaveAttribute('aria-sort', 'ascending');
    await expect(total).not.toHaveAttribute('aria-sort');
    await expect(
      within(table).getByRole('rowheader', { name: /SO-10/ }),
    ).toBeVisible();

    await userEvent.click(within(total).getByRole('button'));
    await expect(total).toHaveAttribute('aria-sort', 'ascending');
    await expect(order).not.toHaveAttribute('aria-sort');
    await userEvent.click(within(total).getByRole('button'));
    await expect(total).toHaveAttribute('aria-sort', 'descending');
    await expect(within(table).getAllByRole('row')[1]).toHaveTextContent(
      '#1002',
    );

    // Row links stay in the tab order; other links in the row keep their own stop.
    const link = within(table).getByRole('link', { name: '#1002' });
    link.focus();
    await expect(link).toHaveFocus();
    await userEvent.tab();
    await expect(
      within(table).getAllByRole('link', { name: 'Source record' })[0],
    ).toHaveFocus();
  },
};

/** Plain tables sit inside a surface that already has a boundary, such as a card. */
export const Compact: Story = {
  args: { density: 'compact', variant: 'plain' },
};

export const NoRows: Story = {
  args: { rows: [] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.queryByRole('table')).toBeNull();
    await expect(
      canvas.getByRole('heading', { name: 'No orders match' }),
    ).toBeVisible();
  },
};

export const Narrow: Story = {
  globals: { viewport: { value: 'mobile1', isRotated: false } },
};
