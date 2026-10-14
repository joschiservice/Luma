import type { Meta, StoryObj } from '@storybook/react-vite';
import { useRef, useState } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';

import type { ConditionWhere } from '../../lib/collection-conditions';
import { useListKeyboard } from '../../lib/list-keyboard';
import { useRowSelection } from '../../lib/row-selection';
import { orderFields } from './collection-story-fixtures';
import { CollectionToolbar } from './collection-toolbar';
import { DataTable, DataTableRowLink } from './data-table';
import { listShortcutGroup, ShortcutHelp } from './shortcut-help';

const orders = [
  { id: 'a', number: 'SO-10', status: 'Open' },
  { id: 'b', number: '#1002', status: 'Completed' },
  { id: 'c', number: '#1003', status: 'Open' },
];

/** A list page wired to the shared keyboard model: J/K, X, Shift+X, Space, Esc, /, F and ?. */
function KeyboardList({ table = true }: { table?: boolean }) {
  const rows = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [preview, setPreview] = useState<string>();
  const [opened, setOpened] = useState<string>();
  const [help, setHelp] = useState(false);
  const [filtering, setFiltering] = useState(false);
  const [where, setWhere] = useState<ConditionWhere>({
    match: 'all',
    conditions: [],
  });
  const selection = useRowSelection({
    keys: orders.map((order) => order.id),
    selected,
    onChange: setSelected,
  });
  const keyboard = useListKeyboard({
    rows,
    count: orders.length,
    onOpen: (index) => setOpened(orders[index]?.number),
    onTogglePreview: (index) =>
      setPreview((current) =>
        current === orders[index]?.id ? undefined : orders[index]?.id,
      ),
    onToggleSelection: (index) => selection.toggle(index),
    onExtendSelection: (index) => selection.toggle(index, true),
    onEscape: () => {
      if (preview) setPreview(undefined);
      else if (selected.length) selection.clear();
      else return false;

      return true;
    },
    onFocusSearch: () => search.current?.focus(),
    onOpenFilter: () => setFiltering(true),
    onShowHelp: () => setHelp(true),
  });

  return (
    <div
      style={{ display: 'grid', gap: 12, width: 'min(720px, 100vw - 32px)' }}
    >
      <CollectionToolbar
        search={{
          value: undefined,
          onChange: () => {},
          label: 'Search orders',
          placeholder: 'Order number…',
          inputRef: search,
        }}
        conditions={{
          fields: orderFields,
          where,
          onWhereChange: setWhere,
          open: filtering,
          onOpenChange: setFiltering,
        }}
        onRefresh={() => {}}
      />
      <div ref={rows}>
        {table ? (
          <DataTable
            caption="Orders"
            columns={[
              {
                key: 'number',
                header: 'Order',
                cell: (order) => (
                  <DataTableRowLink href={`#order-${order.id}`}>
                    {order.number}
                  </DataTableRowLink>
                ),
              },
              {
                key: 'status',
                header: 'Status',
                cell: (order) => order.status,
              },
            ]}
            rows={orders}
            rowKey={(order) => order.id}
            selection={{
              selected,
              onChange: setSelected,
              rowLabel: (order) => order.number,
            }}
            focusedRowKey={orders[keyboard.focusedIndex]?.id}
          />
        ) : (
          <ul aria-label="Orders" className="grid gap-1">
            {orders.map((order, index) => (
              <li key={order.id} {...keyboard.rowProps(index)}>
                {order.number} · {order.status}
              </li>
            ))}
          </ul>
        )}
      </div>
      <output aria-label="List state" style={{ overflowWrap: 'anywhere' }}>
        {JSON.stringify({ selected, preview, opened })}
      </output>
      <ShortcutHelp
        open={help}
        onOpenChange={setHelp}
        groups={[listShortcutGroup()]}
      />
    </div>
  );
}

const meta = {
  title: 'UI/List keyboard',
  component: KeyboardList,
  parameters: { layout: 'padded' },
} satisfies Meta<typeof KeyboardList>;

export default meta;

type Story = StoryObj<typeof meta>;

const listState = (canvasElement: HTMLElement) =>
  within(canvasElement).getByRole('status', { name: 'List state' });

export const Table: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const body = within(document.body);

    await userEvent.keyboard('j');
    await waitFor(() =>
      expect(canvas.getByRole('link', { name: 'SO-10' })).toHaveFocus(),
    );
    await userEvent.keyboard('j');
    await expect(canvas.getByRole('link', { name: '#1002' })).toHaveFocus();
    await expect(
      canvas.getByRole('link', { name: '#1002' }).closest('tr'),
    ).toHaveAttribute('data-focused');

    await userEvent.keyboard('x');
    await expect(listState(canvasElement)).toHaveTextContent(
      '"selected":["b"]',
    );
    await userEvent.keyboard('j');
    await userEvent.keyboard('{Shift>}X{/Shift}');
    await expect(listState(canvasElement)).toHaveTextContent(
      '"selected":["b","c"]',
    );
    await expect(canvas.getByText('2 rows selected')).toBeInTheDocument();
    await userEvent.keyboard(' ');
    await expect(listState(canvasElement)).toHaveTextContent('"preview":"c"');

    // Escape closes the preview first, then clears the selection.
    await userEvent.keyboard('{Escape}');
    await expect(listState(canvasElement)).not.toHaveTextContent('"preview"');
    await userEvent.keyboard('{Escape}');
    await expect(listState(canvasElement)).toHaveTextContent('"selected":[]');

    // Shortcuts never fire while typing.
    await userEvent.keyboard('/');
    const searchbox = canvas.getByRole('searchbox', { name: 'Search orders' });
    await expect(searchbox).toHaveFocus();
    await userEvent.keyboard('jx');
    await expect(searchbox).toHaveValue('jx');
    await expect(listState(canvasElement)).toHaveTextContent('"selected":[]');
    searchbox.blur();

    await userEvent.keyboard('?');
    const help = within(
      await body.findByRole('dialog', { name: 'Keyboard shortcuts' }),
    );
    await waitFor(() =>
      expect(help.getByText('Extend the selection')).toBeVisible(),
    );
    // List keys wait while a dialog is open.
    await userEvent.keyboard('x');
    await userEvent.keyboard('{Escape}');
    await waitFor(() =>
      expect(
        body.queryByRole('dialog', { name: 'Keyboard shortcuts' }),
      ).toBeNull(),
    );
    await expect(listState(canvasElement)).toHaveTextContent('"selected":[]');

    await userEvent.keyboard('f');
    await expect(
      await body.findByRole('dialog', { name: 'Add a filter' }),
    ).toBeVisible();
  },
};

/** Rows without links take focus themselves, and Enter opens them. */
export const PlainList: Story = {
  args: { table: false },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await userEvent.keyboard('jj');
    const second = canvas.getByText(/#1002/);
    await waitFor(() => expect(second).toHaveFocus());
    await expect(second).toHaveAttribute('data-focused');
    await userEvent.keyboard('k');
    await expect(canvas.getByText(/SO-10/)).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await expect(listState(canvasElement)).toHaveTextContent(
      '"opened":"SO-10"',
    );
  },
};

export const Dark: Story = {
  globals: { theme: 'dark' },
  play: async () => {
    await userEvent.keyboard('jx');
  },
};
