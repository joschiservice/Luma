import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';

import { Button } from './button';
import { Select } from './select';

const options = [
  { value: '', label: 'All severities' },
  { value: 'high', label: 'High' },
  { value: 'medium', label: 'Medium' },
  { value: 'low', label: 'Low', disabled: true },
];

const meta = {
  title: 'UI/Select',
  component: Select,
  tags: ['autodocs'],
  parameters: {
    a11y: { context: { include: ['body'] } },
    docs: {
      description: {
        component:
          'Choose one option with the pointer or keyboard. Arrow keys navigate, typing jumps to a matching option, Enter selects, and Escape closes the menu. Provide a visible label or an accessible name.',
      },
    },
  },
  args: { options, 'aria-label': 'Severity', placeholder: 'Choose a severity' },
  decorators: [
    (Story) => (
      <div className="w-64 max-w-full">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof Select>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const trigger = within(canvasElement).getByRole('combobox', {
      name: 'Severity',
    });
    await expect(trigger).toHaveTextContent('Choose a severity');
    await userEvent.click(trigger);
    await within(document.body).findByRole('listbox');
    const menu = within(document.body);
    await expect(menu.getByRole('option', { name: 'Low' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await userEvent.click(menu.getByRole('option', { name: 'High' }));
    await expect(trigger).toHaveTextContent('High');
    await waitFor(() => expect(trigger).toHaveFocus());
    await userEvent.click(trigger);
    await userEvent.click(
      await menu.findByRole('option', { name: 'All severities' }),
    );
    await expect(trigger).toHaveTextContent('All severities');
    await waitFor(() =>
      expect(
        within(document.body).queryByRole('listbox'),
      ).not.toBeInTheDocument(),
    );
  },
};

export const Open: Story = {
  args: { defaultOpen: true, defaultValue: 'high' },
};

export const Selected: Story = { args: { defaultValue: 'medium' } };

export const Disabled: Story = {
  args: { disabled: true, defaultValue: 'high' },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole('combobox')).toBeDisabled();
  },
};

export const Invalid: Story = {
  args: { 'aria-invalid': true, 'aria-describedby': 'severity-error' },
  render: (args) => (
    <div className="grid gap-2">
      <Select {...args} />
      <p id="severity-error" className="text-sm text-destructive">
        Choose a severity.
      </p>
    </div>
  ),
  play: async ({ canvasElement }) => {
    const trigger = within(canvasElement).getByRole('combobox');
    await expect(trigger).toBeInvalid();
    await expect(trigger).toHaveAccessibleDescription('Choose a severity.');
  },
};

export const Keyboard: Story = {
  args: { defaultValue: 'high' },
  play: async ({ canvasElement }) => {
    const trigger = within(canvasElement).getByRole('combobox');
    trigger.focus();
    await expect(trigger).toHaveTextContent('High');
    await userEvent.keyboard('{Enter}');
    await within(document.body).findByRole('listbox');
    await waitFor(() =>
      expect(document.activeElement).toHaveAttribute('role', 'option'),
    );
    await userEvent.keyboard('{ArrowDown}{Enter}');
    await waitFor(() => expect(trigger).toHaveFocus());
    await expect(trigger).toHaveTextContent('Medium');
    await userEvent.keyboard('{Enter}');
    await within(document.body).findByRole('listbox');
    await waitFor(() =>
      expect(document.activeElement).toHaveAttribute('role', 'option'),
    );
    await userEvent.keyboard('{End}{Enter}');
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await expect(trigger).toHaveTextContent('Medium');
    await userEvent.keyboard('{ArrowUp}{Enter}');
    await waitFor(() => expect(trigger).toHaveFocus());
    await expect(trigger).toHaveTextContent('Medium');
    await userEvent.keyboard('{Enter}');
    await within(document.body).findByRole('listbox');
    await waitFor(() =>
      expect(document.activeElement).toHaveAttribute('role', 'option'),
    );
    await userEvent.keyboard('h{Enter}');
    await waitFor(() => expect(trigger).toHaveFocus());
    await expect(trigger).toHaveTextContent('High');
    await userEvent.keyboard('{Enter}');
    await within(document.body).findByRole('listbox');
    await waitFor(() =>
      expect(document.activeElement).toHaveAttribute('role', 'option'),
    );
    await userEvent.keyboard('{ArrowDown}{Escape}');
    await expect(trigger).toHaveTextContent('High');
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await waitFor(() => expect(trigger).toHaveFocus());
  },
};

export const Controlled: Story = {
  render: function ControlledSelect(args) {
    const [value, setValue] = useState<string | null>('high');

    return (
      <div className="grid gap-3">
        <Select {...args} value={value} onValueChange={setValue} />
        <Button variant="outline" onClick={() => setValue('')}>
          Clear filter
        </Button>
      </div>
    );
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('combobox'));
    await userEvent.click(
      await within(document.body).findByRole('option', { name: 'Medium' }),
    );
    await expect(canvas.getByRole('combobox')).toHaveTextContent('Medium');
    await waitFor(() =>
      expect(
        within(document.body).queryByRole('listbox'),
      ).not.toBeInTheDocument(),
    );
    await userEvent.click(canvas.getByRole('button', { name: 'Clear filter' }));
    await expect(canvas.getByRole('combobox')).toHaveTextContent(
      'All severities',
    );
  },
};

export const Form: Story = {
  args: { name: 'severity', defaultValue: 'high' },
  render: (args) => (
    <form aria-label="Issue filters">
      <label className="grid gap-2 text-sm">
        Severity
        <Select {...args} />
      </label>
    </form>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('combobox'));
    await userEvent.click(
      await within(document.body).findByRole('option', { name: 'Medium' }),
    );
    const form = canvas.getByRole('form') as HTMLFormElement;
    await expect(new FormData(form).get('severity')).toBe('medium');
    await waitFor(() =>
      expect(
        within(document.body).queryByRole('listbox'),
      ).not.toBeInTheDocument(),
    );
  },
};

export const LongList: Story = {
  args: {
    defaultOpen: true,
    options: Array.from({ length: 30 }, (_, index) => ({
      value: String(index),
      label: `Connection ${index + 1}`,
    })),
  },
};

export const LongLabel: Story = {
  args: {
    defaultValue: 'review',
    options: [
      {
        value: 'review',
        label: 'Waiting for a team member to review the proposed resolution',
      },
      { value: 'done', label: 'Resolved' },
    ],
  },
};

export const Dark: Story = {
  globals: { theme: 'dark' },
  args: { defaultOpen: true, defaultValue: 'high' },
};
