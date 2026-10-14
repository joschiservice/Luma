import type { Meta, StoryObj } from '@storybook/react-vite';
import { useRef, useState } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';

import { useListKeyboard } from '../../lib/list-keyboard';
import { CollectionGroups } from './collection-groups';
import { CollectionList } from './collection-list';

interface Order {
  id: string;
  number: string;
  total: string;
}

const groups = [
  {
    key: 'open',
    label: 'Open',
    count: 14,
    sums: '€1,240.00 · $86.00',
    items: [
      { id: 'a', number: '#1001', total: '€184.00' },
      { id: 'b', number: '#1002', total: '€42.50' },
    ],
  },
  {
    key: 'completed',
    label: 'Completed',
    count: 2,
    complete: false,
    sums: '€61.00',
    items: [
      { id: 'c', number: '#1003', total: '€12.00' },
      { id: 'd', number: '#1004', total: '€49.00' },
    ],
  },
];

/** Grouped list rows with collapsible sections and the shared list keys. */
function Grouped({
  initiallyCollapsed = [],
}: {
  initiallyCollapsed?: string[];
}) {
  const rows = useRef<HTMLDivElement>(null);
  const [collapsed, setCollapsed] = useState(initiallyCollapsed);
  const [more, setMore] = useState(0);
  const shown = groups.filter((group) => !collapsed.includes(group.key));
  const keys = shown.flatMap((group) => group.items.map((item) => item.id));
  const keyboard = useListKeyboard({ rows, count: keys.length, keys });

  return (
    <div ref={rows} style={{ width: 'min(640px, 100vw - 32px)' }}>
      <CollectionGroups
        label="Orders by status"
        collapsed={collapsed}
        onCollapsedChange={(key, closed) =>
          setCollapsed((current) =>
            closed ? [...current, key] : current.filter((item) => item !== key),
          )
        }
        groups={groups.map((group) => ({
          key: group.key,
          label: group.label,
          count: group.count,
          complete: group.complete,
          summary: group.sums,
          more:
            group.count > group.items.length
              ? { onClick: () => setMore((value) => value + 1) }
              : undefined,
          content: (
            <CollectionList<Order>
              label={group.label}
              items={group.items}
              itemKey={(item) => item.id}
              link={(item) => <a href={`#${item.id}`} />}
              title={(item) => item.number}
              properties={['total']}
              property={(item) => item.total}
              focusedKey={keyboard.focusedKey}
            />
          ),
        }))}
      />
      <output aria-label="Show more presses">{more}</output>
    </div>
  );
}

const meta = {
  title: 'Primitives/Collection groups',
  component: Grouped,
  parameters: { layout: 'centered' },
} satisfies Meta<typeof Grouped>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const open = canvas.getByRole('button', { name: /^Open/ });
    await expect(open).toHaveAttribute('aria-expanded', 'true');
    await expect(canvas.getByText('Incomplete')).toBeVisible();
    await userEvent.click(open);
    await expect(open).toHaveAttribute('aria-expanded', 'false');
    await expect(canvas.queryByRole('link', { name: /#1001/ })).toBeNull();
    await waitFor(() =>
      expect(canvas.getByText('Open collapsed')).toBeInTheDocument(),
    );
    await userEvent.click(open);
    await userEvent.click(
      canvas.getByRole('button', { name: 'Show more in Open' }),
    );
    await expect(canvas.getByLabelText('Show more presses')).toHaveTextContent(
      '1',
    );
  },
};

export const Collapsed: Story = {
  args: { initiallyCollapsed: ['open'] },
};

export const Dark: Story = { globals: { theme: 'dark' } };
