import type { Meta, StoryObj } from '@storybook/react-vite';
import { CalendarDays, CircleDot, Plug } from 'lucide-react';
import { useState } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';

import type { ConditionWhere } from '../../lib/collection-conditions';
import { CollectionDisplay } from './collection-display';
import { type CollectionFilter } from './collection-filters';
import { orderColumns, orderFields } from './collection-story-fixtures';
import { CollectionToolbar, CollectionViews } from './collection-toolbar';

const today = '2026-10-06';

interface State {
  view: 'all' | 'open' | 'late';
  q?: string | undefined;
  status?: string | undefined;
  source?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  sku?: string | undefined;
  payment?: string[] | undefined;
  where?: ConditionWhere | undefined;
  shown?: string[] | undefined;
  sort: string;
  direction: 'asc' | 'desc';
}

function Toolbar({
  initial,
  advanced = false,
}: {
  initial?: Partial<State>;
  /** Adds the condition builder and the display menu. */
  advanced?: boolean;
}) {
  const [state, setState] = useState<State>({
    view: 'all',
    sort: 'updated',
    direction: 'desc',
    ...initial,
  });
  const update = (patch: Partial<State>) =>
    setState((previous) => ({ ...previous, ...patch }));
  const filters: CollectionFilter[] = [
    {
      kind: 'choice',
      key: 'status',
      label: 'Status',
      icon: CircleDot,
      value: state.status,
      options: [
        { value: 'open', label: 'Open' },
        { value: 'completed', label: 'Completed' },
      ],
      onChange: (status) => update({ status }),
    },
    {
      kind: 'choice',
      key: 'source',
      label: 'Source',
      icon: Plug,
      value: state.source,
      options: Array.from({ length: 10 }, (_, index) => ({
        value: `store-${index + 1}`,
        label: `Store ${index + 1}`,
      })),
      onChange: (source) => update({ source }),
    },
    {
      kind: 'date-range',
      key: 'placed',
      label: 'Placed',
      icon: CalendarDays,
      from: state.from,
      to: state.to,
      today,
      maxDays: 366,
      onChange: (range) => update({ from: range.from, to: range.to }),
    },
    {
      kind: 'multi-choice',
      key: 'payment',
      label: 'Payment',
      value: state.payment,
      options: [
        { value: 'pending', label: 'Pending' },
        { value: 'paid', label: 'Paid' },
        { value: 'refunded', label: 'Refunded' },
        { value: 'failed', label: 'Failed' },
      ],
      onChange: (payment) => update({ payment }),
    },
    {
      kind: 'applied',
      key: 'sku',
      label: 'SKU',
      value: state.sku,
      onRemove: () => update({ sku: undefined }),
    },
  ];

  const toolbar = (
    <div style={{ display: 'grid', gap: 12 }}>
      <CollectionToolbar
        views={
          <CollectionViews
            label="Order views"
            value={state.view}
            views={[
              { value: 'all', label: 'All orders' },
              { value: 'open', label: 'Outstanding', count: 12 },
              { value: 'late', label: 'Overdue', count: 3, attention: true },
            ]}
            onChange={(view) => update({ view })}
          />
        }
        search={{
          value: state.q,
          onChange: (q) => update({ q }),
          label: 'Search orders',
          placeholder: 'Order number, source ID or SKU…',
        }}
        filters={filters}
        conditions={
          advanced
            ? {
                fields: orderFields,
                where: state.where ?? { match: 'all', conditions: [] },
                onWhereChange: (where) => update({ where }),
              }
            : undefined
        }
        display={
          advanced ? (
            <CollectionDisplay
              columns={{
                options: orderColumns,
                shown: state.shown ?? ['number', 'status', 'total'],
                onChange: (shown) => update({ shown }),
              }}
              density={{ value: 'comfortable', onChange: () => {} }}
            />
          ) : undefined
        }
        sort={{
          value: state.sort,
          options: [
            { value: 'updated', label: 'Last updated' },
            { value: 'placed', label: 'Placed date' },
          ],
          onChange: (sort) => update({ sort }),
          direction: state.direction,
          onDirectionChange: (direction) => update({ direction }),
        }}
        onClear={() =>
          update({
            q: undefined,
            status: undefined,
            source: undefined,
            from: undefined,
            to: undefined,
            sku: undefined,
            payment: undefined,
            where: undefined,
          })
        }
        onRefresh={() => {}}
        refreshLabel="Refresh orders"
      />
      <output aria-label="Applied state" style={{ overflowWrap: 'anywhere' }}>
        {JSON.stringify(state)}
      </output>
    </div>
  );

  return toolbar;
}

const meta = {
  title: 'UI/Collection toolbar',
  component: Toolbar,
  parameters: { layout: 'padded' },
} satisfies Meta<typeof Toolbar>;

export default meta;

type Story = StoryObj<typeof meta>;

const applied = (canvasElement: HTMLElement) =>
  within(canvasElement).getByRole('status', { name: 'Applied state' });

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const body = within(document.body);

    await userEvent.type(
      canvas.getByRole('searchbox', { name: 'Search orders' }),
      'TOTE{Enter}',
    );
    await expect(applied(canvasElement)).toHaveTextContent('"q":"TOTE"');

    // Every filter is visible while unset and opens its values in one click.
    for (const name of ['Status', 'Source', 'Placed'])
      await expect(
        canvas.getByRole('button', { name: `Add ${name} filter` }),
      ).toBeVisible();
    await userEvent.click(
      canvas.getByRole('button', { name: 'Add Status filter' }),
    );
    await userEvent.click(await body.findByRole('button', { name: 'Open' }));
    await expect(
      canvas.getByRole('button', { name: 'Edit Status filter: Open' }),
    ).toBeVisible();
    await waitFor(() =>
      expect(
        canvas.getByRole('button', { name: 'Edit Status filter: Open' }),
      ).toHaveFocus(),
    );

    await userEvent.click(
      canvas.getByRole('button', { name: 'Add Source filter' }),
    );
    await userEvent.type(
      await body.findByRole('searchbox', { name: 'Find an option' }),
      '10',
    );
    await userEvent.click(body.getByRole('button', { name: 'Store 10' }));
    await expect(
      canvas.getByRole('button', { name: 'Edit Source filter: Store 10' }),
    ).toBeVisible();

    await userEvent.click(
      canvas.getByRole('button', { name: 'Remove Status filter: Open' }),
    );
    await waitFor(() =>
      expect(
        canvas.getByRole('button', { name: 'Add Status filter' }),
      ).toHaveFocus(),
    );

    await userEvent.click(
      canvas.getByRole('button', { name: 'Edit Source filter: Store 10' }),
    );
    await userEvent.click(await body.findByRole('button', { name: 'Any' }));
    await expect(applied(canvasElement)).not.toHaveTextContent('"source"');

    await userEvent.click(canvas.getByRole('button', { name: 'Clear' }));
    await expect(applied(canvasElement)).not.toHaveTextContent('"q"');
    await expect(
      canvas.getByRole('searchbox', { name: 'Search orders' }),
    ).toHaveValue('');
  },
};

export const DateRange: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const body = within(document.body);

    await userEvent.click(
      canvas.getByRole('button', { name: 'Add Placed filter' }),
    );
    await userEvent.click(
      await body.findByRole('button', { name: 'Last 7 days' }),
    );
    await expect(applied(canvasElement)).toHaveTextContent(
      '"from":"2026-09-30","to":"2026-10-06"',
    );

    await userEvent.click(
      canvas.getByRole('button', { name: 'Edit Placed filter: Last 7 days' }),
    );
    const from = await body.findByLabelText('From');
    const through = body.getByLabelText('Through');
    await userEvent.clear(from);
    await userEvent.type(from, '2026-10-05');
    await userEvent.clear(through);
    await userEvent.type(through, '2026-10-01');
    await userEvent.click(body.getByRole('button', { name: 'Apply range' }));
    await expect(await body.findByRole('alert')).toHaveTextContent(
      'Choose an end date on or after the start.',
    );
    await userEvent.clear(from);
    await userEvent.type(from, '2026-09-01');
    await userEvent.click(body.getByRole('button', { name: 'Apply range' }));
    await expect(
      await canvas.findByRole('button', {
        name: /^Edit Placed filter: 1 Sept?\s–\s1 Oct 2026$/,
      }),
    ).toBeVisible();
  },
};

export const AppliedFromLink: Story = {
  args: { initial: { sku: 'TOTE-RED', sort: 'placed' } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const body = within(document.body);

    await expect(canvas.getByText('TOTE-RED')).toBeVisible();
    await userEvent.click(
      canvas.getByRole('button', { name: /^Sort: Placed date/ }),
    );
    await userEvent.click(
      await body.findByRole('menuitemradio', {
        name: 'Oldest or lowest first',
      }),
    );
    await waitFor(() =>
      expect(applied(canvasElement)).toHaveTextContent('"direction":"asc"'),
    );
    await userEvent.click(
      canvas.getByRole('button', { name: 'Remove SKU filter: TOTE-RED' }),
    );
    await expect(canvas.queryByText('TOTE-RED')).not.toBeInTheDocument();
  },
};

export const Narrow: Story = {
  args: { initial: { status: 'open', from: '2026-10-06', to: '2026-10-06' } },
  globals: { viewport: { value: 'mobile1' } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const body = within(document.body);

    // Applied values stay visible as chips; one sheet lists every filter.
    await expect(
      canvas.getByRole('button', { name: 'Edit Status filter: Open' }),
    ).toBeVisible();
    await expect(
      canvas.queryByRole('button', { name: 'Add Source filter' }),
    ).not.toBeInTheDocument();
    await userEvent.click(
      canvas.getByRole('button', { name: 'Filters, 2 applied' }),
    );
    const sheet = within(await body.findByRole('dialog', { name: 'Filters' }));
    await userEvent.click(
      within(sheet.getByRole('region', { name: 'Status' })).getByRole(
        'button',
        { name: 'Completed' },
      ),
    );
    await userEvent.click(sheet.getByRole('button', { name: 'Done' }));
    await expect(applied(canvasElement)).toHaveTextContent(
      '"status":"completed"',
    );
    await expect(
      canvas.getByRole('button', { name: 'Edit Status filter: Completed' }),
    ).toBeVisible();
  },
};

/** Several values of one filter apply together; the picker stays open while toggling. */
export const MultiChoice: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const body = within(document.body);

    await userEvent.click(
      canvas.getByRole('button', { name: 'Add Payment filter' }),
    );
    const picker = within(await body.findByRole('dialog', { name: 'Payment' }));
    await userEvent.click(picker.getByRole('button', { name: 'Paid' }));
    await userEvent.click(picker.getByRole('button', { name: 'Refunded' }));
    await expect(applied(canvasElement)).toHaveTextContent(
      '"payment":["paid","refunded"]',
    );
    await userEvent.click(picker.getByRole('button', { name: 'Done' }));
    await expect(
      canvas.getByRole('button', {
        name: 'Edit Payment filter: Paid or Refunded',
      }),
    ).toBeVisible();
    await userEvent.click(
      canvas.getByRole('button', {
        name: 'Remove Payment filter: Paid or Refunded',
      }),
    );
    await expect(applied(canvasElement)).not.toHaveTextContent('"payment"');
  },
};

/** Advanced conditions follow the quick filters; the display menu sits before Sort. */
export const ConditionsAndDisplay: Story = {
  args: {
    advanced: true,
    initial: {
      status: 'open',
      where: {
        match: 'all',
        conditions: [
          {
            field: 'total',
            op: 'gt',
            value: { amount: '100', currency: 'EUR' },
          },
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const display = canvas.getByRole('button', { name: 'Display' });
    const sort = canvas.getByRole('button', { name: /^Sort:/ });
    await expect(
      display.compareDocumentPosition(sort) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    await expect(
      canvas.getByRole('button', { name: /^Edit filter: Total is more than/ }),
    ).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Clear' }));
    await expect(applied(canvasElement)).not.toHaveTextContent('"where"');
  },
};

export const ConditionsNarrow: Story = {
  args: { ...ConditionsAndDisplay.args },
  globals: { viewport: { value: 'mobile1' } },
};

export const ConditionsDark: Story = {
  args: { ...ConditionsAndDisplay.args },
  globals: { theme: 'dark' },
};
