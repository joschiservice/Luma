import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, within } from 'storybook/test';

import { Pagination } from './pagination';

const meta = {
  title: 'Components/Pagination',
  component: Pagination,
  args: {
    count: 25,
    totalCount: 60,
    page: 1,
    hasNext: true,
    onNext: fn(),
  },
} satisfies Meta<typeof Pagination>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole('navigation', { name: 'Pages' }),
    ).toBeVisible();
    await expect(canvas.getByText('1–25 of 60 items')).toBeVisible();
    await expect(
      canvas.getByRole('button', { name: 'Previous' }),
    ).toBeDisabled();
  },
};

export const Named: Story = {
  args: { page: 3, count: 10, itemLabel: 'orders', label: 'Order pages' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole('navigation', { name: 'Order pages' }),
    ).toBeVisible();
    await expect(canvas.getByText('51–60 of 60 orders')).toBeVisible();
  },
};

export const WithoutTotal: Story = {
  args: {
    page: 2,
    pageSize: 50,
    count: 50,
    totalCount: undefined,
    itemLabel: 'records',
    label: 'Record pages',
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('51–100 records')).toBeVisible();
    await expect(
      canvas.getByRole('navigation', { name: 'Record pages' }),
    ).toHaveTextContent('Page 2');
  },
};
