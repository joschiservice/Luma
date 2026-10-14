import type { Meta, StoryObj } from '@storybook/react-vite';
import { Package } from 'lucide-react';
import { useRef, useState } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';

import { useListKeyboard } from '../../lib/list-keyboard';
import { useRowSelection } from '../../lib/row-selection';
import { CollectionList, type CollectionListDensity } from './collection-list';
import { CollectionPreview } from './collection-preview';
import { Empty } from './empty';
import { StatePill } from './state';

interface Order {
  id: string;
  number: string;
  customer: string;
  note: string;
  status: 'open' | 'held' | 'completed';
  channel: string;
  total: string;
  placed: string;
}

const orders: Order[] = [
  {
    id: 'a',
    number: '#1001',
    customer: 'Northstar Supply',
    note: 'Two lines, ships from Berlin',
    status: 'held',
    channel: 'Shopify',
    total: '€184.00',
    placed: '2h ago',
  },
  {
    id: 'b',
    number: '#1002',
    customer: 'Ada Lovelace',
    note: 'Gift wrap requested',
    status: 'open',
    channel: 'Shopify',
    total: '€42.50',
    placed: '3h ago',
  },
  {
    id: 'c',
    number: 'SO-10',
    customer: 'Brightwater Hotels GmbH & Co. KG — Einkauf Zentrale',
    note: 'Wholesale order with a long customer name that has to truncate',
    status: 'completed',
    channel: 'JTL',
    total: '€2,940.00',
    placed: 'Yesterday',
  },
];

const statusLabel = { open: 'Open', held: 'On hold', completed: 'Completed' };
const statusState = {
  open: 'idle',
  held: 'attention',
  completed: 'verified',
} as const;

/** A list page with the shared keyboard model, optional selection and an optional preview. */
function OrderList({
  density = 'comfortable',
  properties = ['customer', 'channel', 'total', 'placed'],
  items = orders,
  loading = false,
  selectable = false,
  preview: withPreview = false,
  width = 720,
}: {
  density?: CollectionListDensity;
  properties?: string[];
  items?: Order[];
  loading?: boolean;
  selectable?: boolean;
  preview?: boolean;
  width?: number;
}) {
  const rows = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [open, setOpen] = useState<string>();
  const keys = items.map((order) => order.id);
  const selection = useRowSelection({ keys, selected, onChange: setSelected });
  const keyboard = useListKeyboard({
    rows,
    count: items.length,
    keys,
    preview: withPreview ? { open, onOpenChange: setOpen } : undefined,
    onToggleSelection: selectable
      ? (index) => selection.toggle(index)
      : undefined,
    onExtendSelection: selectable
      ? (index) => selection.toggle(index, true)
      : undefined,
  });
  const openOrder = items.find((order) => order.id === open);
  const list = (
    <div ref={rows}>
      <CollectionList
        label="Orders"
        items={items}
        itemKey={(order) => order.id}
        link={(order) => (
          <a
            id={`order-${order.id}`}
            href={`#order-${order.id}`}
            onClick={(event) => {
              if (!withPreview) return;
              event.preventDefault();
              setOpen(order.id);
            }}
          />
        )}
        leading={() => <Package size={16} aria-hidden="true" />}
        title={(order) => order.number}
        description={(order) => order.note}
        status={(order) => (
          <StatePill state={statusState[order.status]}>
            {statusLabel[order.status]}
          </StatePill>
        )}
        properties={properties}
        property={(order, key) =>
          key === 'customer'
            ? order.customer
            : key === 'channel'
              ? order.channel
              : key === 'total'
                ? order.total
                : key === 'placed'
                  ? order.placed
                  : null
        }
        density={density}
        current={open}
        focusedKey={keyboard.focusedKey}
        selection={
          selectable
            ? { selected, onChange: setSelected, rowLabel: (o) => o.number }
            : undefined
        }
        loading={
          loading ? (
            <p role="status" className="text-sm">
              Loading orders…
            </p>
          ) : undefined
        }
        empty={
          <Empty>
            <h2>No orders in this view</h2>
            <p>Orders that match the view's filters appear here.</p>
          </Empty>
        }
      />
    </div>
  );

  return (
    <div
      style={{
        display: 'grid',
        gap: 12,
        width: `min(${width}px, 100vw - 32px)`,
      }}
    >
      {withPreview ? (
        <div style={{ height: 420, display: 'grid' }}>
          <CollectionPreview
            open={!!openOrder}
            onClose={() => setOpen(undefined)}
            label="Order preview"
            title={openOrder?.number}
            list={list}
            preview={
              openOrder ? (
                <dl>
                  <dt>Customer</dt>
                  <dd>{openOrder.customer}</dd>
                  <dt>Total</dt>
                  <dd>{openOrder.total}</dd>
                </dl>
              ) : null
            }
          />
        </div>
      ) : (
        list
      )}
      <output aria-label="List state">
        {JSON.stringify({ selected, open })}
      </output>
    </div>
  );
}

const meta = {
  title: 'UI/Collection list',
  component: OrderList,
  parameters: { layout: 'padded' },
} satisfies Meta<typeof OrderList>;

export default meta;

type Story = StoryObj<typeof meta>;

const listState = (canvasElement: HTMLElement) =>
  within(canvasElement).getByRole('status', { name: 'List state' });

/** Rows are list items with one link each; J and K move focus between the links. */
export const Comfortable: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const list = canvas.getByRole('list', { name: 'Orders' });
    await expect(within(list).getAllByRole('listitem')).toHaveLength(3);
    await expect(
      canvas.getByText('Two lines, ships from Berlin'),
    ).toBeVisible();
    await expect(canvas.getByText('On hold')).toBeVisible();

    await userEvent.keyboard('j');
    const first = canvas.getByRole('link', { name: /#1001/ });
    await waitFor(() => expect(first).toHaveFocus());
    await userEvent.keyboard('j');
    const second = canvas.getByRole('link', { name: /#1002/ });
    await expect(second).toHaveFocus();
    await expect(second.closest('li')).toHaveAttribute('data-focused');
  },
};

/** Compact rows drop the description and keep the title and properties on one line. */
export const Compact: Story = {
  args: { density: 'compact' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.queryByText('Two lines, ships from Berlin')).toBeNull();
    await expect(canvas.getByText('Northstar Supply')).toBeVisible();
  },
};

/** Properties follow the Display menu: only the chosen keys, in the chosen order. */
export const ChosenProperties: Story = {
  args: { properties: ['total', 'channel'] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.queryByText('Northstar Supply')).toBeNull();
    const row = canvas.getByRole('link', { name: /#1001/ });
    const shown = [...row.querySelectorAll('[data-property]')].map((item) =>
      item.getAttribute('data-property'),
    );
    await expect(shown).toEqual(['total', 'channel']);
  },
};

export const Dark: Story = {
  globals: { theme: 'dark' },
  play: async () => {
    await userEvent.keyboard('j');
  },
};

/** Narrow lists move status and properties under the title. */
export const Narrow: Story = {
  args: { width: 340 },
};

export const NarrowDark: Story = {
  args: { width: 340 },
  globals: { theme: 'dark' },
};

/** The caller's empty state describes this view. */
export const NoRows: Story = {
  args: { items: [] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole('heading', { name: 'No orders in this view' }),
    ).toBeVisible();
    await expect(canvas.queryByRole('list')).toBeNull();
  },
};

export const Loading: Story = {
  args: { loading: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('Loading orders…')).toBeVisible();
    await expect(canvas.queryByRole('list')).toBeNull();
  },
};

/** Checkboxes and X select rows; Shift+X and shift-click extend the selection. */
export const Selection: Story = {
  args: { selectable: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // One user session keeps Shift held across the click.
    const user = userEvent.setup();
    await user.click(canvas.getByRole('checkbox', { name: 'Select #1001' }));
    await expect(listState(canvasElement)).toHaveTextContent(
      '"selected":["a"]',
    );
    await user.keyboard('{Shift>}');
    await user.click(canvas.getByRole('checkbox', { name: 'Select SO-10' }));
    await user.keyboard('{/Shift}');
    await expect(listState(canvasElement)).toHaveTextContent(
      '"selected":["a","b","c"]',
    );
    await expect(canvas.getByText('3 rows selected')).toBeInTheDocument();
    canvas.getByRole('link', { name: /#1002/ }).focus();
    await userEvent.keyboard('x');
    await expect(listState(canvasElement)).toHaveTextContent(
      '"selected":["a","c"]',
    );
  },
};

/**
 * Space opens the focused record next to the list, J and K move the open record, and Escape
 * closes it and returns focus to the row.
 */
export const WithPreview: Story = {
  args: { preview: true, width: 960 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.keyboard('j');
    await waitFor(() =>
      expect(canvas.getByRole('link', { name: /#1001/ })).toHaveFocus(),
    );
    await userEvent.keyboard(' ');
    const preview = canvas.getByRole('region', { name: 'Order preview' });
    await expect(
      within(preview).getByRole('heading', { name: '#1001' }),
    ).toBeVisible();
    // The preview opens beside the list, so focus stays on the row.
    await expect(canvas.getByRole('link', { name: /#1001/ })).toHaveFocus();
    await expect(canvas.getByRole('link', { name: /#1001/ })).toHaveAttribute(
      'aria-current',
      'page',
    );

    await userEvent.keyboard('j');
    await expect(
      within(preview).getByRole('heading', { name: '#1002' }),
    ).toBeVisible();
    await expect(listState(canvasElement)).toHaveTextContent('"open":"b"');

    await userEvent.keyboard('{Escape}');
    await waitFor(() =>
      expect(
        canvas.queryByRole('region', { name: 'Order preview' }),
      ).toBeNull(),
    );
    await expect(canvas.getByRole('link', { name: /#1002/ })).toHaveFocus();

    // A click opens the preview too; Escape inside it closes it and returns to the row.
    await userEvent.click(canvas.getByRole('link', { name: /SO-10/ }));
    const reopened = canvas.getByRole('region', { name: 'Order preview' });
    within(reopened).getByRole('button', { name: 'Close preview' }).focus();
    await userEvent.keyboard('{Escape}');
    await waitFor(() =>
      expect(canvas.getByRole('link', { name: /SO-10/ })).toHaveFocus(),
    );
  },
};

/** On small screens the preview is a full-screen sheet with a way back to the list. */
export const PreviewNarrow: Story = {
  args: { preview: true, width: 360 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('link', { name: /#1002/ }));
    const preview = canvas.getByRole('region', { name: 'Order preview' });
    await waitFor(() => expect(preview).toHaveFocus());
    await userEvent.click(
      within(preview).getByRole('button', { name: 'Back to list' }),
    );
    await waitFor(() =>
      expect(canvas.getByRole('link', { name: /#1002/ })).toHaveFocus(),
    );
  },
};
