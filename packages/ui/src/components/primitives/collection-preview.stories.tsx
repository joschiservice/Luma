import type { Meta, StoryObj } from '@storybook/react-vite';
import { useRef, useState } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';

import { useListKeyboard } from '../../lib/list-keyboard';
import { CollectionPreview } from './collection-preview';
import { DataTable, DataTableRowLink } from './data-table';
import { listShortcutGroup, ShortcutHelp } from './shortcut-help';

const orders = [
  { id: 'a', number: '#1001', customer: 'Northstar Supply', total: '€184.00' },
  { id: 'b', number: '#1002', customer: 'Ada Lovelace', total: '€42.50' },
  {
    id: 'c',
    number: 'SO-10',
    customer: 'Brightwater Hotels',
    total: '€2,940.00',
  },
];

/**
 * A table page with the preview pane, as Orders would wire it: the open record is page state
 * (the URL in the app), the keyboard hook toggles and moves it, and the preview links to the
 * full record.
 */
function TablePreview({ width = 1080 }: { width?: number }) {
  const rows = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState<string>();
  const [help, setHelp] = useState(false);
  const keys = orders.map((order) => order.id);
  const keyboard = useListKeyboard({
    rows,
    count: orders.length,
    keys,
    preview: { open, onOpenChange: setOpen },
    onShowHelp: () => setHelp(true),
  });
  const current = orders.find((order) => order.id === open);

  return (
    <div
      style={{
        width: `min(${width}px, 100vw - 32px)`,
        height: 360,
        display: 'grid',
      }}
    >
      <CollectionPreview
        open={!!current}
        onClose={() => setOpen(undefined)}
        label="Order preview"
        title={current?.number}
        actions={
          current ? <a href={`#order-${current.id}`}>Open order</a> : null
        }
        list={
          <div ref={rows}>
            <DataTable
              caption="Orders"
              columns={[
                {
                  key: 'number',
                  header: 'Order',
                  cell: (order) => (
                    <DataTableRowLink
                      href={`#order-${order.id}`}
                      aria-current={order.id === open ? 'page' : undefined}
                      onClick={(event) => {
                        event.preventDefault();
                        setOpen(order.id);
                      }}
                    >
                      {order.number}
                    </DataTableRowLink>
                  ),
                },
                {
                  key: 'customer',
                  header: 'Customer',
                  cell: (o) => o.customer,
                },
                {
                  key: 'total',
                  header: 'Total',
                  numeric: true,
                  cell: (o) => o.total,
                },
              ]}
              rows={orders}
              rowKey={(order) => order.id}
              focusedRowKey={keyboard.focusedKey}
            />
          </div>
        }
        preview={
          current ? (
            <dl>
              <dt>Customer</dt>
              <dd>{current.customer}</dd>
              <dt>Total</dt>
              <dd>{current.total}</dd>
            </dl>
          ) : null
        }
      />
      <ShortcutHelp
        open={help}
        onOpenChange={setHelp}
        groups={[
          listShortcutGroup([
            'next',
            'previous',
            'open',
            'preview',
            'escape',
            'help',
          ]),
        ]}
      />
    </div>
  );
}

const meta = {
  title: 'UI/Collection preview',
  component: TablePreview,
  parameters: { layout: 'padded' },
} satisfies Meta<typeof TablePreview>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Table: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.keyboard('j');
    await waitFor(() =>
      expect(canvas.getByRole('link', { name: '#1001' })).toHaveFocus(),
    );
    await userEvent.keyboard(' ');
    const preview = canvas.getByRole('region', { name: 'Order preview' });
    await expect(within(preview).getByText('Northstar Supply')).toBeVisible();
    await userEvent.keyboard('jj');
    await expect(
      within(preview).getByRole('heading', { name: 'SO-10' }),
    ).toBeVisible();
    await userEvent.keyboard('k');
    await expect(
      within(preview).getByRole('heading', { name: '#1002' }),
    ).toBeVisible();
    // Space toggles the open record closed again.
    await userEvent.keyboard(' ');
    await waitFor(() =>
      expect(
        canvas.queryByRole('region', { name: 'Order preview' }),
      ).toBeNull(),
    );
    await expect(canvas.getByRole('link', { name: '#1002' })).toHaveFocus();
  },
};

export const TableDark: Story = {
  globals: { theme: 'dark' },
  play: async ({ canvasElement }) => {
    await userEvent.click(
      within(canvasElement).getByRole('link', { name: '#1002' }),
    );
  },
};

/** On small screens the preview covers the list; Escape returns to the row. */
export const TableNarrow: Story = {
  args: { width: 360 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('link', { name: 'SO-10' }));
    const preview = canvas.getByRole('region', { name: 'Order preview' });
    await waitFor(() => expect(preview).toHaveFocus());
    await userEvent.keyboard('{Escape}');
    await waitFor(() =>
      expect(canvas.getByRole('link', { name: 'SO-10' })).toHaveFocus(),
    );
  },
};
