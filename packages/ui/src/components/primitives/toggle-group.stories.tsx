import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, userEvent, within } from 'storybook/test';

import { ToggleGroup, ToggleGroupItem } from './toggle-group';

const sources = ['Shopify', 'JTL-Wawi', 'Starshipit'];

function SourceChoice() {
  const [value, setValue] = useState(sources[0]!);

  return (
    <div style={{ display: 'grid', gap: 12, padding: 24 }}>
      <ToggleGroup
        aria-label="Show report from"
        value={[value]}
        onValueChange={([next]) => {
          if (next) setValue(next);
        }}
      >
        {sources.map((source) => (
          <ToggleGroupItem key={source} value={source}>
            {source}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      <p>Showing {value}</p>
    </div>
  );
}

const meta = {
  title: 'UI/ToggleGroup',
  component: SourceChoice,
} satisfies Meta<typeof SourceChoice>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const first = canvas.getByRole('button', { name: 'Shopify' });
    await expect(first).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(canvas.getByRole('button', { name: 'JTL-Wawi' }));
    await expect(canvas.getByText('Showing JTL-Wawi')).toBeVisible();
    // Pressing the chosen option again keeps it chosen.
    await userEvent.click(canvas.getByRole('button', { name: 'JTL-Wawi' }));
    await expect(canvas.getByText('Showing JTL-Wawi')).toBeVisible();
  },
};

export const Keyboard: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.tab();
    await expect(canvas.getByRole('button', { name: 'Shopify' })).toHaveFocus();
    await userEvent.keyboard('{ArrowRight}');
    await expect(
      canvas.getByRole('button', { name: 'JTL-Wawi' }),
    ).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await expect(canvas.getByText('Showing JTL-Wawi')).toBeVisible();
  },
};

export const Dark: Story = { globals: { theme: 'dark' } };
