import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, fn, userEvent, within } from 'storybook/test';

import {
  BarChart,
  type ChartCategory,
  ChartLegend,
  type ChartSelection,
  type ChartSeries,
} from './bar-chart';

const series: ChartSeries[] = [
  { id: 'open', label: 'Open', color: 'chart-1' },
  { id: 'completed', label: 'Completed', color: 'chart-2' },
  { id: 'cancelled', label: 'Cancelled', color: 'chart-3' },
  { id: 'unknown', label: 'Status unknown', color: 'muted' },
];

const dayLabel = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
});

const days: ChartCategory[] = Array.from({ length: 14 }, (_, index) => {
  const date = new Date(Date.UTC(2026, 8, 18 + index));
  const values = {
    open: [2, 3, 1, 4, 6, 5, 3, 2, 7, 8, 6, 9, 5, 3][index]!,
    completed: [9, 11, 8, 12, 14, 10, 6, 7, 13, 12, 15, 11, 4, 0][index]!,
    cancelled: [1, 0, 0, 2, 1, 0, 0, 1, 0, 2, 1, 0, 0, 0][index]!,
    unknown: index === 6 ? 1 : 0,
  };

  return {
    key: date.toISOString().slice(0, 10),
    label: dayLabel.format(date),
    values,
    ...(index < 3
      ? { unknown: 'Not imported: before the imported history.' }
      : {}),
    ...(index === 13 ? { note: 'Today so far' } : {}),
  };
});

const stages: ChartCategory[] = [
  ['draft', 'Draft · not sent', 3, 0],
  ['awaiting_confirmation', 'Sent · awaiting confirmation', 5, 2],
  ['confirmed', 'Confirmed by supplier', 4, 1],
  ['partially_received', 'Partly received', 2, 0],
  ['received', 'Received', 6, 0],
].map(([key, label, onTime, overdue]) => ({
  key: String(key),
  label: String(label),
  values: { not_overdue: Number(onTime), overdue: Number(overdue) },
}));

function Interactive({
  orientation,
  onSelect,
}: {
  orientation: 'vertical' | 'horizontal';
  onSelect: (selection: ChartSelection) => void;
}) {
  const [selected, setSelected] = useState<ChartSelection | null>(null);
  const shown =
    orientation === 'vertical'
      ? series
      : [
          {
            id: 'not_overdue',
            label: 'Not overdue',
            color: 'chart-1' as const,
          },
          { id: 'overdue', label: 'Overdue', color: 'warning' as const },
        ];

  return (
    <div style={{ display: 'grid', gap: 12, maxWidth: 760, padding: 24 }}>
      <BarChart
        label={
          orientation === 'vertical'
            ? 'Orders placed per day'
            : 'Purchase orders by stage'
        }
        orientation={orientation}
        series={shown}
        categories={orientation === 'vertical' ? days : stages}
        unit={(value) => `${value} ${value === 1 ? 'order' : 'orders'}`}
        selected={selected}
        onSelect={(selection) => {
          setSelected(selection);
          onSelect(selection);
        }}
      />
      <ChartLegend series={shown} />
    </div>
  );
}

const meta = {
  title: 'UI/Bar chart',
  component: Interactive,
  args: { orientation: 'vertical', onSelect: fn() },
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof Interactive>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Timeline: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const chart = canvas.getByRole('group', { name: 'Orders placed per day' });
    const bars = within(chart).getAllByRole('button');
    // One tab stop: only the first bar is reachable with Tab.
    await expect(bars.filter((bar) => bar.tabIndex === 0)).toHaveLength(1);
    await expect(bars[0]).toHaveAccessibleName(
      'Sep 18: Not imported: before the imported history.',
    );
    await expect(bars[13]).toHaveAccessibleName(
      'Oct 1: 3 orders. Today so far.',
    );
    await expect(bars[4]).toHaveAccessibleName(
      'Sep 22: 21 orders. Open 6, Completed 14, Cancelled 1.',
    );
    await userEvent.click(bars[3]!);
    await expect(args.onSelect).toHaveBeenLastCalledWith({
      category: '2026-09-21',
      series: undefined,
    });
    await userEvent.keyboard('{ArrowRight}{Enter}');
    await expect(args.onSelect).toHaveBeenLastCalledWith({
      category: '2026-09-22',
      series: undefined,
    });
    await expect(bars[4]).toHaveFocus();
    await expect(bars[4]).toHaveAttribute('aria-pressed', 'true');
  },
};

export const Breakdown: Story = {
  args: { orientation: 'horizontal' },
  play: async ({ canvasElement, args }) => {
    const chart = within(canvasElement).getByRole('group', {
      name: 'Purchase orders by stage',
    });
    const rows = within(chart).getAllByRole('button');
    await expect(rows[1]).toHaveAccessibleName(
      'Sent · awaiting confirmation: 7 orders. Not overdue 5, Overdue 2.',
    );
    const overdue = rows[1]!.querySelector('[data-series="overdue"]');
    await userEvent.click(overdue!);
    await expect(args.onSelect).toHaveBeenLastCalledWith({
      category: 'awaiting_confirmation',
      series: 'overdue',
    });
  },
};

export const Dark: Story = { globals: { theme: 'dark' } };

export const Narrow: Story = {
  globals: { viewport: { value: 'mobile1' } },
};
