import { figmaDesign } from '@luma/ui/lib/figma';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';

import { Button } from './button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from './dialog';

const meta = {
  title: 'UI/Dialog',
  component: Dialog,
  // The popup is portaled outside the story root; include it in axe checks.
  parameters: {
    a11y: { context: { include: ['body'] } },
    design: figmaDesign('dialog'),
  },
  render: (args) => (
    <Dialog {...args}>
      <DialogTrigger render={<Button variant="outline" />}>
        Open details
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Room for the work ahead.</DialogTitle>
          <DialogDescription>
            A quiet place to focus on the details that matter.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose render={<Button />}>Done</DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  ),
} satisfies Meta<typeof Dialog>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const page = within(canvasElement.ownerDocument.body);
    const trigger = canvas.getByRole('button', { name: 'Open details' });
    await userEvent.click(trigger);
    const dialog = await page.findByRole('dialog', {
      name: 'Room for the work ahead.',
    });
    await waitFor(() => expect(dialog).toBeVisible());
    await expect(dialog).toHaveAccessibleDescription(
      'A quiet place to focus on the details that matter.',
    );
    await waitFor(() =>
      expect(dialog.contains(canvasElement.ownerDocument.activeElement)).toBe(
        true,
      ),
    );
    // Focus guards return focus to the popup on the next animation frame.
    for (const shift of [false, true]) {
      for (let index = 0; index < 3; index++) {
        await userEvent.tab({ shift });
        await waitFor(() =>
          expect(
            dialog.contains(canvasElement.ownerDocument.activeElement),
          ).toBe(true),
        );
      }
    }
    await userEvent.keyboard('{Escape}');
    await waitFor(() =>
      expect(page.queryByRole('dialog')).not.toBeInTheDocument(),
    );
    await waitFor(() => expect(trigger).toHaveFocus());
    await userEvent.click(trigger);
    await userEvent.click(await page.findByRole('button', { name: 'Done' }));
    await waitFor(() =>
      expect(page.queryByRole('dialog')).not.toBeInTheDocument(),
    );
    await waitFor(() => expect(trigger).toHaveFocus());
  },
};

// Leave the popup open so its rendered state receives an accessibility scan.
export const Open: Story = { args: { defaultOpen: true } };

export const Dark: Story = {
  args: { defaultOpen: true },
  globals: { theme: 'dark' },
};
