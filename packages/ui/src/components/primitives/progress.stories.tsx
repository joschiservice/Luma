import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';

import { Progress } from './progress';

const meta = {
  title: 'UI/Progress',
  component: Progress,
  args: { value: 42, label: 'Order history import' },
  decorators: [
    (Story) => (
      <div style={{ maxWidth: 320 }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof Progress>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Determinate: Story = {
  args: { valueText: '420 of about 1,000 orders' },
  play: async ({ canvasElement }) => {
    const bar = within(canvasElement).getByRole('progressbar', {
      name: 'Order history import',
    });
    await expect(bar).toHaveAttribute('aria-valuenow', '42');
    await expect(bar).toHaveAttribute(
      'aria-valuetext',
      '420 of about 1,000 orders',
    );
  },
};

export const UnknownTotal: Story = {
  args: { value: null, label: 'Product import' },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByRole('progressbar', {
        name: 'Product import',
      }),
    ).not.toHaveAttribute('aria-valuenow');
  },
};

export const Complete: Story = { args: { value: 100 } };
