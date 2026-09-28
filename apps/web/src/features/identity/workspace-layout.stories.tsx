import { PageHeader } from '@luma/ui/components/workspace/page-header';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { MINIMAL_VIEWPORTS } from 'storybook/viewport';

import { StoryShell } from './storybook-shell';

function ShellExample({
  workspaceName = 'Northstar Commerce',
  accountName = 'Alex Morgan',
}: {
  workspaceName?: string;
  accountName?: string;
}) {
  return (
    <StoryShell workspace={workspaceName} account={accountName}>
      {(page) => (
        <PageHeader
          title={page}
          description="Review your operations, investigate issues, and manage connected systems."
        />
      )}
    </StoryShell>
  );
}

const meta = {
  title: 'App/Workspace shell',
  component: ShellExample,
  parameters: {
    layout: 'fullscreen',
    viewport: { options: MINIMAL_VIEWPORTS },
  },
} satisfies Meta<typeof ShellExample>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Desktop: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('link', { name: /^Issues/ }));
    await expect(canvas.getByRole('heading', { name: 'Issues' })).toBeVisible();
    await expect(canvas.getByRole('link', { name: /^Issues/ })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await userEvent.click(
      canvas.getByRole('button', { name: /Switch workspace/ }),
    );
    const body = within(canvasElement.ownerDocument.body);
    await waitFor(() =>
      expect(
        body.getByRole('menuitem', { name: 'Create workspace' }),
      ).toBeVisible(),
    );
    await userEvent.click(
      await body.findByRole('menuitem', { name: 'Northstar Europe' }),
    );
    await expect(
      canvas.getByRole('button', {
        name: /Northstar Europe. Switch workspace/,
      }),
    ).toBeVisible();
    await userEvent.click(
      canvas.getByRole('button', { name: /Open account menu/ }),
    );
    await waitFor(() =>
      expect(body.getByRole('menuitem', { name: 'Sign out' })).toBeVisible(),
    );
    await expect(
      body.getByRole('menuitemradio', { name: 'System' }),
    ).toBeChecked();
    await userEvent.keyboard('{Escape}');
    await waitFor(() =>
      expect(
        canvas.getByRole('button', { name: /Open account menu/ }),
      ).toHaveFocus(),
    );
  },
};

export const Collapsed: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      canvas.getByRole('button', { name: 'Collapse sidebar' }),
    );
    await expect(canvasElement.querySelector('.desk')).toHaveAttribute(
      'data-sidebar',
      'collapsed',
    );
    await expect(
      canvas.getByRole('link', { name: /^Workflows/ }),
    ).toBeVisible();
    await userEvent.click(
      canvas.getByRole('button', { name: 'Expand sidebar' }),
    );
  },
};

export const Dark: Story = {
  globals: { theme: 'dark' },
};

export const LongNames: Story = {
  args: {
    workspaceName:
      'Northstar Commerce — International Operations and Fulfilment',
    accountName: 'Alexandra Morgan-Sutherland',
  },
};

export const Mobile: Story = {
  globals: { viewport: { value: 'mobile1', isRotated: false } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const menu = canvas.getByRole('button', { name: 'Menu' });
    await userEvent.click(menu);
    const body = within(canvasElement.ownerDocument.body);
    const dialog = await body.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('link', { name: 'Apps' }));
    await expect(canvas.getByRole('heading', { name: 'Apps' })).toBeVisible();
    await waitFor(() =>
      expect(body.queryByRole('dialog')).not.toBeInTheDocument(),
    );
    await waitFor(() => expect(menu).toHaveFocus());
  },
};

export const MobileDrawer: Story = {
  globals: { viewport: { value: 'mobile1', isRotated: false } },
  play: async ({ canvasElement }) => {
    await userEvent.click(
      within(canvasElement).getByRole('button', { name: 'Menu' }),
    );
    const dialog = await within(canvasElement.ownerDocument.body).findByRole(
      'dialog',
    );
    const bounds = dialog.getBoundingClientRect();
    await expect(bounds.x).toBeGreaterThanOrEqual(0);
    await expect(bounds.y).toBeGreaterThanOrEqual(0);
    await expect(bounds.right).toBeLessThanOrEqual(window.innerWidth);
  },
};
