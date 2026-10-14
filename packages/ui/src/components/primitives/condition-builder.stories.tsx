import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';

import type {
  ConditionField,
  ConditionIssue,
  ConditionWhere,
} from '../../lib/collection-conditions';
import { Button } from './button';
import {
  manyFields,
  orderFields,
  storyWhere,
} from './collection-story-fixtures';
import { CollectionToolbar } from './collection-toolbar';

function Builder({
  fields = orderFields,
  initial = { match: 'all', conditions: [] },
  issues,
  preset,
}: {
  fields?: ConditionField[];
  initial?: ConditionWhere;
  issues?: ConditionIssue[];
  /** Opens the builder at this field, as a column's "Filter by this column" does. */
  preset?: string;
}) {
  const [where, setWhere] = useState<ConditionWhere>(initial);
  const [open, setOpen] = useState(false);

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <CollectionToolbar
        search={{
          value: undefined,
          onChange: () => {},
          label: 'Search orders',
          placeholder: 'Order number…',
        }}
        conditions={{
          fields,
          where,
          onWhereChange: setWhere,
          issues,
          open,
          onOpenChange: setOpen,
          field: preset,
        }}
        onClear={() => setWhere({ match: 'all', conditions: [] })}
        onRefresh={() => {}}
      />
      {preset ? (
        <Button variant="outline" onClick={() => setOpen(true)}>
          Filter by this column
        </Button>
      ) : null}
      <output aria-label="Applied state" style={{ overflowWrap: 'anywhere' }}>
        {JSON.stringify(where)}
      </output>
    </div>
  );
}

const meta = {
  title: 'UI/Condition builder',
  component: Builder,
  parameters: { layout: 'padded' },
} satisfies Meta<typeof Builder>;

export default meta;

type Story = StoryObj<typeof meta>;

const applied = (canvasElement: HTMLElement) =>
  within(canvasElement).getByRole('status', { name: 'Applied state' });
const body = within(document.body);

async function pickField(canvasElement: HTMLElement, name: string) {
  await userEvent.click(
    within(canvasElement).getByRole('button', { name: 'Add a filter' }),
  );
  const picker = within(
    await body.findByRole('dialog', { name: 'Add a filter' }),
  );
  await userEvent.type(
    picker.getByRole('searchbox', { name: 'Find a field' }),
    name.slice(0, 4),
  );
  await userEvent.click(picker.getByRole('button', { name }));

  return within(await body.findByRole('dialog', { name }));
}

async function chooseOption(label: string, option: string) {
  await userEvent.click(body.getByRole('combobox', { name: label }));
  await userEvent.click(await body.findByRole('option', { name: option }));
}

/** Field, then values; the chip names the whole condition. */
export const AddChoice: Story = {
  play: async ({ canvasElement }) => {
    const editor = await pickField(canvasElement, 'Status');
    await userEvent.click(editor.getByRole('button', { name: 'Apply filter' }));
    await expect(await editor.findByRole('alert')).toHaveTextContent(
      'Choose a value to apply this filter.',
    );
    await userEvent.click(editor.getByRole('button', { name: 'Open' }));
    await userEvent.click(editor.getByRole('button', { name: 'Completed' }));
    await userEvent.click(editor.getByRole('button', { name: 'Apply filter' }));
    await expect(applied(canvasElement)).toHaveTextContent(
      '{"field":"status","op":"any_of","value":["open","completed"]}',
    );
    await expect(
      within(canvasElement).getByRole('button', {
        name: 'Edit filter: Status is any of Open or Completed',
      }),
    ).toBeVisible();
  },
};

/** Amounts carry a currency when the list offers more than one. */
export const AddMoney: Story = {
  play: async ({ canvasElement }) => {
    const editor = await pickField(canvasElement, 'Total');
    await chooseOption('Condition', 'is more than');
    await userEvent.type(editor.getByLabelText('Amount'), '100,5');
    await chooseOption('Currency', 'USD');
    await userEvent.click(editor.getByRole('button', { name: 'Apply filter' }));
    await expect(applied(canvasElement)).toHaveTextContent(
      '{"field":"total","op":"gt","value":{"amount":"100.5","currency":"USD"}}',
    );
  },
};

/** Relative periods and "today" resolve when the list is read. */
export const AddRelativeDate: Story = {
  play: async ({ canvasElement }) => {
    const editor = await pickField(canvasElement, 'Placed');
    await chooseOption('Condition', 'is in the last');
    const amount = editor.getByLabelText('Number of periods');
    await userEvent.clear(amount);
    await userEvent.type(amount, '2');
    await chooseOption('Period', 'Weeks');
    await userEvent.click(editor.getByRole('button', { name: 'Apply filter' }));
    await expect(
      await within(canvasElement).findByRole('button', {
        name: 'Edit filter: Placed is in the last 2 weeks',
      }),
    ).toBeVisible();

    const second = await pickField(canvasElement, 'Placed');
    await userEvent.click(second.getByRole('button', { name: 'Today' }));
    await userEvent.click(second.getByRole('button', { name: 'Apply filter' }));
    await expect(applied(canvasElement)).toHaveTextContent(
      '{"field":"placed","op":"before","value":{"dynamic":"today"}}',
    );
  },
};

/** Person fields offer "Me"; per-source fields choose which source counts. */
export const PersonAndSource: Story = {
  play: async ({ canvasElement }) => {
    const editor = await pickField(canvasElement, 'Assignee');
    await userEvent.click(editor.getByRole('button', { name: 'Me' }));
    await userEvent.click(editor.getByRole('button', { name: 'Apply filter' }));
    await expect(applied(canvasElement)).toHaveTextContent(
      '"value":[{"dynamic":"me"}]',
    );

    const stock = await pickField(canvasElement, 'Available stock');
    await chooseOption('Source', 'Lowest across sources');
    await userEvent.type(stock.getByLabelText('Value'), '5');
    await userEvent.click(stock.getByRole('button', { name: 'Apply filter' }));
    await expect(applied(canvasElement)).toHaveTextContent(
      '{"field":"available","op":"lt","value":5,"source":"lowest"}',
    );
  },
};

/** Applied conditions edit in place and combine with all or any. */
export const EditAndMatch: Story = {
  args: { initial: storyWhere },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      canvas.getByRole('button', { name: 'Match all filters' }),
    );
    await userEvent.click(
      await body.findByRole('menuitemradio', { name: 'Match any filter' }),
    );
    await waitFor(() =>
      expect(applied(canvasElement)).toHaveTextContent('"match":"any"'),
    );

    await userEvent.click(
      canvas.getByRole('button', {
        name: 'Edit filter: Status is any of Open or Completed',
      }),
    );
    const editor = within(await body.findByRole('dialog', { name: 'Status' }));
    await userEvent.click(editor.getByRole('button', { name: 'Completed' }));
    await userEvent.click(editor.getByRole('button', { name: 'Apply filter' }));
    await expect(
      canvas.getByRole('button', {
        name: 'Edit filter: Status is any of Open',
      }),
    ).toBeVisible();

    await userEvent.click(
      canvas.getByRole('button', {
        name: 'Remove filter: Placed is in the last 30 days',
      }),
    );
    await expect(applied(canvasElement)).not.toHaveTextContent('"placed"');
  },
};

/** A condition the list rejected stays visible with the reason and can be fixed or removed. */
export const RejectedCondition: Story = {
  args: {
    initial: {
      match: 'all',
      conditions: [
        { field: 'status', op: 'any_of', value: ['open'] },
        { field: 'warehouse', op: 'any_of', value: ['berlin'] },
      ],
    },
    issues: [
      { index: 0, message: 'This value is not one of the field’s options' },
      { index: 1, message: 'Your role cannot filter by this field' },
    ],
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      canvas.getByRole('button', {
        name: /^Status is any of Open\. This filter can’t be applied/,
      }),
    );
    const editor = within(await body.findByRole('dialog', { name: 'Status' }));
    await expect(
      editor.getByText('This value is not one of the field’s options'),
    ).toBeVisible();
    await userEvent.keyboard('{Escape}');
    await expect(
      canvas.getByText('Your role cannot filter by this field'),
    ).toBeInTheDocument();
    await expect(
      canvas.getByRole('button', {
        name: 'Remove filter: Warehouse is any of berlin',
      }),
    ).toBeVisible();
  },
};

/** Unavailable fields stay in the list, disabled with their reason. */
export const ManyFields: Story = {
  args: { fields: manyFields },
  play: async ({ canvasElement }) => {
    await userEvent.click(
      within(canvasElement).getByRole('button', { name: 'Add a filter' }),
    );
    const picker = within(
      await body.findByRole('dialog', { name: 'Add a filter' }),
    );
    await expect(
      picker.getByRole('button', { name: /^Warehouse/ }),
    ).toBeDisabled();
    await expect(
      picker.getByRole('group', { name: 'Custom fields' }),
    ).toBeVisible();
    await userEvent.type(
      picker.getByRole('searchbox', { name: 'Find a field' }),
      'field 27',
    );
    await expect(picker.getAllByRole('button')).toHaveLength(2);
    await userEvent.keyboard('{Enter}');
    await expect(
      await body.findByRole('dialog', { name: 'Custom field 27' }),
    ).toBeVisible();
  },
};

export const Narrow: Story = {
  args: { initial: storyWhere },
  globals: { viewport: { value: 'mobile1' } },
  play: async ({ canvasElement }) => {
    await userEvent.click(
      within(canvasElement).getByRole('button', { name: 'Add a filter' }),
    );
    await expect(
      await body.findByRole('dialog', { name: 'Add a filter' }),
    ).toBeVisible();
  },
};

export const Dark: Story = {
  args: {
    initial: storyWhere,
    issues: [{ index: 1, message: 'Date groups need a day, week or month' }],
  },
  globals: { theme: 'dark' },
};

/** A column menu opens the builder at its field; the field list stays one step back. */
export const PresetField: Story = {
  args: { preset: 'overdue' },
  play: async ({ canvasElement }) => {
    await userEvent.click(
      within(canvasElement).getByRole('button', {
        name: 'Filter by this column',
      }),
    );
    const editor = within(await body.findByRole('dialog', { name: 'Overdue' }));
    await userEvent.click(editor.getByRole('button', { name: 'No' }));
    await userEvent.click(editor.getByRole('button', { name: 'Apply filter' }));
    await expect(applied(canvasElement)).toHaveTextContent(
      '{"field":"overdue","op":"is","value":false}',
    );
  },
};
