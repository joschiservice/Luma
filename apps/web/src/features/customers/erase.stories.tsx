import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';

import appStyles from '../../styles.css?inline';
import { EraseCustomerDialog, type ErasurePreviewState } from './erase';

const counts = { profiles: 1, messages: 14, threads: 6, replies: 2, rules: 1 };

function Preview({
  preview = { state: 'ready', counts },
  error = null,
  pending = false,
}: {
  preview?: ErasurePreviewState;
  error?: 'forbidden' | 'failed' | null;
  pending?: boolean;
}) {
  return (
    <>
      <style>{appStyles}</style>
      <EraseCustomerDialog
        open
        name="Avery Tan"
        preview={preview}
        error={error}
        pending={pending}
        retryPreview={() => {}}
        confirm={() => {}}
        close={() => {}}
      />
    </>
  );
}

const meta = {
  title: 'Customers/Erase customer',
  component: Preview,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof Preview>;

export default meta;

type Story = StoryObj<typeof meta>;

// The dialog renders in a portal outside the story canvas.
const screen = () => within(document.body);

export const ShowsWhatWillBeErased: Story = {
  play: async () => {
    const preview = await screen().findByRole('region', {
      name: 'What will be erased',
    });
    await expect(within(preview).getByText('Inbox messages')).toBeVisible();
    await expect(within(preview).getByText('14')).toBeVisible();
    await expect(
      screen().getByRole('button', { name: 'Erase customer' }),
    ).toBeEnabled();
  },
};

export const Dark: Story = { globals: { theme: 'dark' } };

export const Narrow: Story = {
  globals: { viewport: { value: 'mobile1', isRotated: false } },
};

export const Checking: Story = {
  args: { preview: { state: 'loading' } },
  play: async () => {
    await expect(
      await screen().findByText('Checking what will be erased…'),
    ).toBeVisible();
    // Nothing can be erased before the person has seen what it removes.
    await expect(
      screen().getByRole('button', { name: 'Erase customer' }),
    ).toBeDisabled();
  },
};

export const PreviewFailed: Story = {
  args: { preview: { state: 'failed' } },
  play: async () => {
    await expect(
      await screen().findByText('Luma couldn’t check what will be erased.'),
    ).toBeVisible();
    await expect(screen().getByRole('button', { name: 'Retry' })).toBeVisible();
    await expect(
      screen().getByRole('button', { name: 'Erase customer' }),
    ).toBeDisabled();
  },
};

export const Erasing: Story = {
  args: { pending: true },
  play: async () => {
    await expect(
      await screen().findByRole('button', { name: 'Erasing…' }),
    ).toBeDisabled();
    await expect(
      screen().getByRole('button', { name: 'Cancel' }),
    ).toBeDisabled();
  },
};

export const EraseFailed: Story = {
  args: { error: 'failed' },
  play: async () => {
    await expect(
      await screen().findByText('The customer couldn’t be erased. Try again.'),
    ).toBeVisible();
  },
};

export const PermissionLost: Story = {
  args: { error: 'forbidden' },
  play: async () => {
    await expect(
      await screen().findByText(
        'You no longer have permission to erase customers.',
      ),
    ).toBeVisible();
  },
};
