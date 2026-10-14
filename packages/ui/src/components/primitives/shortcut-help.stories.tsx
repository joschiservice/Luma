import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';

import { Button } from './button';
import { listShortcutGroup, ShortcutHelp } from './shortcut-help';

function Help({ only }: { only?: Parameters<typeof listShortcutGroup>[0] }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        Keyboard shortcuts
      </Button>
      <ShortcutHelp
        open={open}
        onOpenChange={setOpen}
        groups={[listShortcutGroup(only)]}
      />
    </>
  );
}

const meta = {
  title: 'UI/Shortcut help',
  component: Help,
} satisfies Meta<typeof Help>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const body = within(document.body);
    await userEvent.click(
      within(canvasElement).getByRole('button', { name: 'Keyboard shortcuts' }),
    );
    const dialog = within(
      await body.findByRole('dialog', { name: 'Keyboard shortcuts' }),
    );
    await waitFor(() =>
      expect(dialog.getByRole('region', { name: 'Lists' })).toBeVisible(),
    );
    await expect(dialog.getByText('Move down')).toBeVisible();
    await expect(dialog.getAllByText('or')).toHaveLength(2);
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(body.queryByRole('dialog')).toBeNull());
  },
};

/** A page lists only the commands it handles. */
export const PageCommands: Story = {
  args: { only: ['next', 'previous', 'open', 'search', 'help'] },
  play: async ({ canvasElement }) => {
    const body = within(document.body);
    await userEvent.click(
      within(canvasElement).getByRole('button', { name: 'Keyboard shortcuts' }),
    );
    const dialog = within(await body.findByRole('dialog'));
    await expect(dialog.queryByText('Extend the selection')).toBeNull();
  },
};

export const Dark: Story = {
  globals: { theme: 'dark' },
  play: async ({ canvasElement }) => {
    await userEvent.click(
      within(canvasElement).getByRole('button', { name: 'Keyboard shortcuts' }),
    );
  },
};
