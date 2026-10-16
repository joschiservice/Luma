import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ComponentProps } from 'react';
import { expect, userEvent, within } from 'storybook/test';

import { Tabs, TabsContent, TabsList, TabsTrigger } from './tabs';

const views = [
  { value: 'runs', label: 'Runs', text: 'Recent runs and their results.' },
  { value: 'overview', label: 'How it works', text: 'What starts a run.' },
  { value: 'setup', label: 'Setup', text: 'Rules and activations.' },
];

function Example({
  orientation,
  variant,
}: {
  orientation?: ComponentProps<typeof Tabs>['orientation'];
  variant?: ComponentProps<typeof TabsList>['variant'];
}) {
  return (
    <div style={{ padding: 24, maxWidth: 560 }}>
      <Tabs defaultValue="runs" orientation={orientation}>
        <TabsList aria-label="Workflow" variant={variant}>
          {views.map((view) => (
            <TabsTrigger key={view.value} value={view.value}>
              {view.label}
            </TabsTrigger>
          ))}
        </TabsList>
        {views.map((view) => (
          <TabsContent key={view.value} value={view.value}>
            <p>{view.text}</p>
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}

const meta = {
  title: 'UI/Tabs',
  component: Example,
} satisfies Meta<typeof Example>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const list = canvas.getByRole('tablist', { name: 'Workflow' });
    // Horizontal tabs stack the list above its panel at the height of a default button.
    await expect(getComputedStyle(list.parentElement!).flexDirection).toBe(
      'column',
    );
    await expect(list.getBoundingClientRect().height).toBe(32);
    await userEvent.click(canvas.getByRole('tab', { name: 'Setup' }));
    await expect(canvas.getByText('Rules and activations.')).toBeVisible();
  },
};

export const Line: Story = {
  args: { variant: 'line' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const active = canvas.getByRole('tab', { name: 'Runs', selected: true });
    const other = canvas.getByRole('tab', { name: 'Setup' });
    // Only the selected tab is underlined.
    await expect(getComputedStyle(active, '::after').opacity).toBe('1');
    await expect(getComputedStyle(other, '::after').opacity).toBe('0');
    await userEvent.keyboard('{Tab}{ArrowRight}{ArrowRight}{Enter}');
    await expect(
      canvas.getByRole('tab', { name: 'Setup', selected: true }),
    ).toBeVisible();
  },
};

export const Vertical: Story = {
  args: { orientation: 'vertical' },
  play: async ({ canvasElement }) => {
    const list = within(canvasElement).getByRole('tablist', {
      name: 'Workflow',
    });
    // Vertical tabs sit beside their panel and stack their triggers.
    await expect(getComputedStyle(list.parentElement!).flexDirection).toBe(
      'row',
    );
    await expect(getComputedStyle(list).flexDirection).toBe('column');
  },
};

export const Dark: Story = {
  args: { variant: 'line' },
  globals: { theme: 'dark' },
};
