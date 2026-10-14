import type { Meta, StoryObj } from '@storybook/react-vite';
import { useRef, useState } from 'react';
import { expect, userEvent, within } from 'storybook/test';

import { useListKeyboard } from '../../lib/list-keyboard';
import {
  CollectionBoard,
  type CollectionBoardColumn,
} from './collection-board';
import { StatePill } from './state';

interface Order {
  id: string;
  number: string;
  total: string;
  channel: string;
  overdue?: boolean;
}

const initial: CollectionBoardColumn<Order>[] = [
  {
    key: 'unfulfilled',
    label: 'Unfulfilled',
    count: 12,
    summary: '€1,240.00',
    items: [
      {
        id: 'a',
        number: '#1001',
        total: '€184.00',
        channel: 'Online Store',
        overdue: true,
      },
      { id: 'b', number: '#1002', total: '€42.50', channel: 'POS' },
      { id: 'c', number: '#1003', total: '€12.00', channel: 'Online Store' },
    ],
  },
  {
    key: 'partial',
    label: 'Partially fulfilled',
    count: 1,
    complete: false,
    items: [{ id: 'd', number: 'SO-10', total: '€2,940.00', channel: 'JTL' }],
  },
  { key: 'fulfilled', label: 'Fulfilled', count: 0, items: [] },
];

/** A read-only board, or one that offers moves, with the shared list keys. */
function Board({ movable = false }: { movable?: boolean }) {
  const rows = useRef<HTMLDivElement>(null);
  const [columns, setColumns] = useState(initial);
  const keys = columns.flatMap((column) => column.items.map((item) => item.id));
  const keyboard = useListKeyboard({ rows, count: keys.length, keys });

  return (
    <div ref={rows} style={{ width: 'min(760px, 100vw - 32px)' }}>
      <CollectionBoard<Order>
        label="Orders by fulfillment"
        columns={columns.map((column) => ({
          ...column,
          more:
            column.count > column.items.length
              ? { onClick: () => {} }
              : undefined,
        }))}
        itemKey={(item) => item.id}
        link={(item) => <a href={`#${item.id}`} />}
        title={(item) => item.number}
        status={(item) =>
          item.overdue ? <StatePill state="attention">Overdue</StatePill> : null
        }
        properties={['total', 'channel']}
        property={(item, key) => (key === 'total' ? item.total : item.channel)}
        focusedKey={keyboard.focusedKey}
        onMove={
          movable
            ? (item, target) =>
                setColumns((current) =>
                  current.map((column) => ({
                    ...column,
                    items:
                      column.key === target
                        ? [...column.items, item]
                        : column.items.filter((other) => other.id !== item.id),
                  })),
                )
            : undefined
        }
      />
    </div>
  );
}

const meta = {
  title: 'Primitives/Collection board',
  component: Board,
  parameters: { layout: 'centered' },
} satisfies Meta<typeof Board>;

export default meta;

type Story = StoryObj<typeof meta>;

export const ReadOnly: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.queryByRole('button', { name: 'Move to…' })).toBeNull();
    const first = canvas.getByRole('link', { name: /#1001/ });
    first.focus();
    await userEvent.keyboard('{ArrowDown}');
    await expect(canvas.getByRole('link', { name: /#1002/ })).toHaveFocus();
    await userEvent.keyboard('{ArrowRight}');
    await expect(canvas.getByRole('link', { name: /SO-10/ })).toHaveFocus();
    await userEvent.keyboard('{ArrowLeft}');
    await expect(canvas.getByRole('link', { name: /#1001/ })).toHaveFocus();
    await userEvent.keyboard('j');
    await expect(canvas.getByRole('link', { name: /#1002/ })).toHaveFocus();
  },
};

export const Movable: Story = {
  args: { movable: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const page = within(canvasElement.ownerDocument.body);
    canvas.getByRole('link', { name: /#1002/ }).focus();
    await userEvent.keyboard('m');
    await userEvent.click(
      await page.findByRole('menuitem', { name: 'Fulfilled' }),
    );
    const fulfilled = canvas.getByRole('region', { name: /Fulfilled/ });
    await expect(
      within(fulfilled).getByRole('link', { name: /#1002/ }),
    ).toBeVisible();
  },
};

export const Narrow: Story = {
  globals: { viewport: { value: 'mobile1', isRotated: false } },
};

export const Dark: Story = { globals: { theme: 'dark' } };
