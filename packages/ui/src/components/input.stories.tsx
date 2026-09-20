import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';

import { Input } from './input';

const meta = {
  title: 'UI/Input',
  component: Input,
  args: { 'aria-label': 'Workspace name', placeholder: 'Workspace name' },
} satisfies Meta<typeof Input>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const input = within(canvasElement).getByRole('textbox', {
      name: 'Workspace name',
    });
    await userEvent.type(input, 'Luma');
    await expect(input).toHaveValue('Luma');
  },
};

export const Disabled: Story = {
  args: { disabled: true, defaultValue: 'Luma' },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole('textbox')).toBeDisabled();
  },
};

export const Invalid: Story = {
  args: { 'aria-invalid': true, 'aria-describedby': 'workspace-error' },
  render: (args) => (
    <div className="flex w-72 flex-col gap-2">
      <Input {...args} />
      <p id="workspace-error" className="text-sm text-destructive">
        Enter a workspace name.
      </p>
    </div>
  ),
  play: async ({ canvasElement }) => {
    const input = within(canvasElement).getByRole('textbox');
    await expect(input).toBeInvalid();
    await expect(input).toHaveAccessibleDescription('Enter a workspace name.');
  },
};

export const Dark: Story = { globals: { theme: 'dark' } };
