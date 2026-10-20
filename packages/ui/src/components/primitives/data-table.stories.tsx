import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';

import { Badge } from './badge';
import { Card } from './card';
import { storyColumnState } from './collection-story-fixtures';
import {
  DataTable,
  type DataTableColumn,
  type DataTableColumnState,
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

export const PrimitiveRows: Story = {
  render: function PrimitiveRowsPreview() {
    const [selected, setSelected] = useState<string[]>([]);

    return (
      <DataTable
        caption="Orders"
        rows={orders.map((order) => order.number)}
        rowKey={(number) => number}
        columns={[{ key: 'number', header: 'Order', cell: (number) => number }]}
        selection={{
          selected,
          onChange: setSelected,
          rowLabel: (number) => number,
        }}
      />
    );
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole('rowheader', { name: 'SO-10' }),
    ).toBeVisible();
    await userEvent.click(
      canvas.getByRole('checkbox', { name: 'Select SO-10' }),
    );
    await expect(
      canvas.getByRole('checkbox', { name: 'Select SO-10' }),
    ).toBeChecked();
    await expect(
      canvas.getByRole('rowheader', { name: 'SO-10' }).closest('tr'),
    ).toHaveAttribute('data-selected');
    await expect(
      canvas.getByRole('checkbox', { name: 'Select #1002' }),
    ).not.toBeChecked();
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

/** Columns people can resize, reorder, pin and hide, with row selection. */
function Configurable({
  initial = { columns: [] },
  selectable = true,
}: {
  initial?: DataTableColumnState;
  selectable?: boolean;
}) {
  const [state, setState] = useState(initial);
  const [selected, setSelected] = useState<string[]>([]);
  const [sort, setSort] = useState<DataTableSort<SortKey>>({
    key: 'number',
    direction: 'asc',
  });
  const [filtered, setFiltered] = useState<string>();
  const configurable = columns.map((column) => ({
    ...column,
    label: typeof column.header === 'string' ? column.header : column.key,
    filterable: column.key === 'status',
  }));

  return (
    <div
      style={{ display: 'grid', gap: 12, width: 'min(720px, 100vw - 32px)' }}
    >
      <DataTable
        caption="Orders"
        columns={configurable}
        rows={orders}
        rowKey={(order) => order.id}
        sort={sort}
        onSortChange={setSort}
        columnState={state}
        onColumnStateChange={setState}
        onColumnFilter={setFiltered}
        selection={
          selectable
            ? {
                selected,
                onChange: setSelected,
                rowLabel: (order) => order.number,
              }
            : undefined
        }
        focusedRowKey="b"
      />
      <output aria-label="Table state" style={{ overflowWrap: 'anywhere' }}>
        {JSON.stringify({ state, selected, sort, filtered })}
      </output>
    </div>
  );
}

const tableState = (canvasElement: HTMLElement) =>
  within(canvasElement).getByRole('status', { name: 'Table state' });

export const ConfigurableColumns: Story = {
  render: () => <Configurable selectable={false} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const body = within(document.body);

    // Column menus sort, filter, move and hide.
    await userEvent.click(
      canvas.getByRole('button', { name: 'Total column options' }),
    );
    await userEvent.click(
      await body.findByRole('menuitem', { name: 'Sort descending' }),
    );
    await expect(
      canvas.getByRole('columnheader', { name: /Total/ }),
    ).toHaveAttribute('aria-sort', 'descending');

    await userEvent.click(
      canvas.getByRole('button', { name: 'Status column options' }),
    );
    await userEvent.click(
      await body.findByRole('menuitem', { name: 'Filter by this column' }),
    );
    await expect(tableState(canvasElement)).toHaveTextContent(
      '"filtered":"status"',
    );

    await userEvent.click(
      canvas.getByRole('button', { name: 'Total column options' }),
    );
    await userEvent.click(
      await body.findByRole('menuitem', { name: 'Move left' }),
    );
    await userEvent.keyboard('{Escape}');
    await expect(tableState(canvasElement)).toHaveTextContent(
      '"columns":[{"key":"number"},{"key":"status"},{"key":"total"},{"key":"source"}]',
    );

    await userEvent.click(
      canvas.getByRole('button', { name: 'Status column options' }),
    );
    await userEvent.click(
      await body.findByRole('menuitem', { name: 'Hide column' }),
    );
    await expect(
      canvas.queryByRole('columnheader', { name: /Status/ }),
    ).toBeNull();
    await waitFor(() =>
      expect(
        canvas.getByRole('button', { name: 'Total column options' }),
      ).toHaveFocus(),
    );

    // The row header column can't be hidden.
    await userEvent.click(
      canvas.getByRole('button', { name: 'Order column options' }),
    );
    await expect(
      await body.findByRole('menuitem', { name: 'Move right' }),
    ).toBeInTheDocument();
    await expect(
      body.queryByRole('menuitem', { name: 'Hide column' }),
    ).toBeNull();
    await userEvent.keyboard('{Escape}');

    // Resize handles work with the arrow keys; Enter resets the width.
    const handle = canvas.getByRole('separator', {
      name: 'Resize Order column',
    });
    handle.focus();
    await userEvent.keyboard('{ArrowRight}');
    await expect(tableState(canvasElement)).toHaveTextContent(
      '{"key":"number","width":196}',
    );
    await userEvent.keyboard('{Shift>}{ArrowLeft}{/Shift}');
    await expect(tableState(canvasElement)).toHaveTextContent(
      '{"key":"number","width":132}',
    );
    await userEvent.keyboard('{Enter}');
    await expect(tableState(canvasElement)).not.toHaveTextContent('"width"');
  },
};

export const PinnedColumn: Story = {
  render: () => (
    <Configurable initial={{ ...storyColumnState, pinned: 'total' }} />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const headers = canvas.getAllByRole('columnheader');
    await expect(headers[1]).toHaveTextContent('Total');
    await expect(headers[1]).toHaveAttribute('data-pinned');
    await userEvent.click(
      canvas.getByRole('button', { name: 'Total column options' }),
    );
    await expect(
      await within(document.body).findByRole('menuitem', {
        name: 'Move right',
      }),
    ).toHaveAttribute('aria-disabled', 'true');
    await userEvent.click(
      within(document.body).getByRole('menuitem', { name: 'Unpin column' }),
    );
    await expect(tableState(canvasElement)).not.toHaveTextContent('"pinned"');
    // The accessibility check runs after play; let the menu and its focus guards close first.
    await waitFor(() =>
      expect(within(document.body).queryByRole('menu')).toBeNull(),
    );
  },
};

export const Selection: Story = {
  render: () => <Configurable />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const all = canvas.getByRole('checkbox', {
      name: 'Select all rows on this page',
    });

    const user = userEvent.setup();

    await user.click(canvas.getByRole('checkbox', { name: 'Select SO-10' }));
    await expect(all).toBePartiallyChecked();
    await user.keyboard('{Shift>}');
    await user.click(canvas.getByRole('checkbox', { name: 'Select #1003' }));
    await user.keyboard('{/Shift}');
    await expect(tableState(canvasElement)).toHaveTextContent(
      '"selected":["a","b","c"]',
    );
    await expect(all).toBeChecked();
    await expect(canvas.getByText('3 rows selected')).toBeInTheDocument();

    await userEvent.click(all);
    await expect(tableState(canvasElement)).toHaveTextContent('"selected":[]');
    await expect(canvas.getByText('Selection cleared')).toBeInTheDocument();
  },
};

export const ConfigurableNarrow: Story = {
  render: () => <Configurable initial={storyColumnState} />,
  globals: { viewport: { value: 'mobile1', isRotated: false } },
};

export const ConfigurableDark: Story = {
  render: () => (
    <Configurable initial={{ ...storyColumnState, pinned: 'number' }} />
  ),
  globals: { theme: 'dark' },
};
