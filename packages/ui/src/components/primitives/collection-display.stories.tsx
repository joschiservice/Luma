import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';

import {
  CollectionDisplay,
  type DisplayColumn,
  type DisplayDensity,
  type DisplayGrouping,
  type DisplayLayout,
} from './collection-display';
import { orderColumns } from './collection-story-fixtures';

const initialShown = ['number', 'status', 'total', 'legacyChannel'];

function Display({
  columns = orderColumns,
  layouts = ['table', 'list', 'board'],
  properties = false,
  previewOption = false,
}: {
  columns?: DisplayColumn[];
  layouts?: DisplayLayout[];
  /** Names the fields as list row properties. */
  properties?: boolean;
  /** Offers the preview pane. */
  previewOption?: boolean;
}) {
  const [shown, setShown] = useState(initialShown);
  const [preview, setPreview] = useState(false);
  const [density, setDensity] = useState<DisplayDensity>('comfortable');
  const [layout, setLayout] = useState<DisplayLayout>('table');
  const [grouping, setGrouping] = useState<DisplayGrouping | null>(null);
  const modified =
    shown.join() !== initialShown.join() ||
    density !== 'comfortable' ||
    layout !== 'table' ||
    grouping !== null;

  return (
    <div style={{ display: 'grid', gap: 12, justifyItems: 'end' }}>
      <CollectionDisplay
        columns={{
          options: columns,
          shown,
          onChange: setShown,
          kind: properties ? 'properties' : 'columns',
        }}
        density={{ value: density, onChange: setDensity }}
        preview={
          previewOption ? { value: preview, onChange: setPreview } : undefined
        }
        layout={{ value: layout, options: layouts, onChange: setLayout }}
        grouping={{
          value: grouping,
          fields: [
            { value: 'status', label: 'Status' },
            {
              value: 'placed',
              label: 'Placed',
              granularities: ['day', 'week', 'month'],
            },
          ],
          onChange: setGrouping,
        }}
        modified={modified}
        onReset={() => {
          setShown(initialShown);
          setDensity('comfortable');
          setLayout('table');
          setGrouping(null);
        }}
      />
      <output
        aria-label="Display state"
        style={{ overflowWrap: 'anywhere', justifySelf: 'stretch' }}
      >
        {JSON.stringify({ shown, density, layout, grouping, preview })}
      </output>
    </div>
  );
}

const meta = {
  title: 'UI/Collection display',
  component: Display,
  parameters: { layout: 'padded' },
} satisfies Meta<typeof Display>;

export default meta;

type Story = StoryObj<typeof meta>;

const state = (canvasElement: HTMLElement) =>
  within(canvasElement).getByRole('status', { name: 'Display state' });
const body = within(document.body);

async function open(canvasElement: HTMLElement) {
  await userEvent.click(
    within(canvasElement).getByRole('button', { name: 'Display' }),
  );

  return within(await body.findByRole('dialog', { name: 'Display options' }));
}

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const panel = await open(canvasElement);

    await userEvent.click(panel.getByRole('checkbox', { name: 'Status' }));
    await userEvent.click(
      panel.getByRole('checkbox', { name: 'Payment status' }),
    );
    await expect(state(canvasElement)).toHaveTextContent(
      '"shown":["number","total","legacyChannel","paymentStatus"]',
    );

    // The handle reorders with the arrow keys and announces the new position.
    const handle = panel.getByRole('button', { name: 'Move Payment status' });
    handle.focus();
    await userEvent.keyboard('{ArrowUp}');
    await expect(state(canvasElement)).toHaveTextContent(
      '"shown":["number","total","paymentStatus","legacyChannel"]',
    );
    await expect(
      panel.getByText('Payment status moved to position 3 of 4'),
    ).toBeInTheDocument();
    await waitFor(() => expect(handle).toHaveFocus());

    // Alt+arrow keys reorder from the checkbox too.
    panel.getByRole('checkbox', { name: 'Total' }).focus();
    await userEvent.keyboard('{Alt>}{ArrowDown}{/Alt}');
    await expect(state(canvasElement)).toHaveTextContent(
      '"shown":["number","paymentStatus","total","legacyChannel"]',
    );

    await userEvent.click(panel.getByRole('radio', { name: 'Compact' }));
    await expect(state(canvasElement)).toHaveTextContent('"density":"compact"');

    // Board needs a grouping first.
    await expect(panel.getByRole('radio', { name: 'Board' })).toBeDisabled();
    await userEvent.click(panel.getByRole('combobox', { name: 'Group by' }));
    await userEvent.click(await body.findByRole('option', { name: 'Placed' }));
    await expect(state(canvasElement)).toHaveTextContent(
      '"grouping":{"field":"placed","showEmpty":false,"granularity":"day"}',
    );
    await userEvent.click(panel.getByRole('combobox', { name: 'Period' }));
    await userEvent.click(await body.findByRole('option', { name: 'Week' }));
    await userEvent.click(
      panel.getByRole('checkbox', { name: 'Show empty groups' }),
    );
    await expect(state(canvasElement)).toHaveTextContent(
      '"grouping":{"field":"placed","showEmpty":true,"granularity":"week"}',
    );
    await userEvent.click(panel.getByRole('radio', { name: 'Board' }));
    await expect(state(canvasElement)).toHaveTextContent('"layout":"board"');

    await userEvent.click(panel.getByRole('button', { name: 'Reset to view' }));
    await expect(state(canvasElement)).toHaveTextContent(
      '"density":"comfortable","layout":"table","grouping":null',
    );
  },
};

/** Required and unavailable columns stay listed with the reason they can't change. */
export const UnavailableColumns: Story = {
  play: async ({ canvasElement }) => {
    const panel = await open(canvasElement);
    await expect(panel.getByRole('checkbox', { name: 'Order' })).toBeDisabled();
    await expect(panel.getByText('Always shown')).toBeVisible();
    const warehouse = panel.getByRole('checkbox', { name: 'Warehouse' });
    await expect(warehouse).toBeDisabled();
    await expect(warehouse).toHaveAccessibleDescription(
      'Where the order ships from. Your role cannot see fulfillment. Source',
    );
    // A shown column that became unavailable can still be hidden.
    const archived = panel.getByRole('checkbox', {
      name: 'Sales channel (archived)',
    });
    await expect(archived).toBeEnabled();
    await userEvent.click(archived);
    await expect(state(canvasElement)).not.toHaveTextContent('legacyChannel');
  },
};

export const Search: Story = {
  args: {
    columns: [
      ...orderColumns,
      ...Array.from({ length: 30 }, (_, index) => ({
        key: `custom${index + 1}`,
        label: `Custom field ${index + 1}`,
        group: 'Custom fields',
        origin: 'luma' as const,
      })),
    ],
  },
  play: async ({ canvasElement }) => {
    const panel = await open(canvasElement);
    await userEvent.type(
      panel.getByRole('searchbox', { name: 'Find a column' }),
      'field 12',
    );
    await waitFor(() => expect(panel.getAllByRole('checkbox')).toHaveLength(1));
    // Reordering pauses while the list is filtered.
    await expect(panel.queryByRole('button', { name: /^Move/ })).toBeNull();
    await userEvent.type(
      panel.getByRole('searchbox', { name: 'Find a column' }),
      'xyz',
    );
    await expect(await panel.findByText('No columns match')).toBeVisible();
  },
};

/** List pages name fields as row properties and may offer the preview pane. */
export const ListProperties: Story = {
  args: { layouts: ['list'], properties: true, previewOption: true },
  play: async ({ canvasElement }) => {
    const panel = await open(canvasElement);
    await expect(
      panel.getByRole('heading', { name: 'Properties' }),
    ).toBeVisible();
    await expect(
      panel.getByRole('searchbox', { name: 'Find a property' }),
    ).toBeVisible();
    const preview = panel.getByRole('checkbox', {
      name: 'Open records in a preview',
    });
    await userEvent.click(preview);
    await expect(state(canvasElement)).toHaveTextContent('"preview":true');
  },
};

/** With one layout there is nothing to choose, so the picker is left out. */
export const SingleLayout: Story = {
  args: { layouts: ['table'] },
  play: async ({ canvasElement }) => {
    const panel = await open(canvasElement);
    await expect(panel.queryByRole('radio', { name: 'Table' })).toBeNull();
    await expect(panel.getByRole('radio', { name: 'Compact' })).toBeVisible();
  },
};

export const Narrow: Story = {
  globals: { viewport: { value: 'mobile1' } },
  play: async ({ canvasElement }) => {
    const panel = await open(canvasElement);
    await expect(
      panel.getByRole('radio', { name: 'Comfortable' }),
    ).toBeChecked();
  },
};

export const Dark: Story = {
  globals: { theme: 'dark' },
  play: async ({ canvasElement }) => {
    await open(canvasElement);
  },
};
