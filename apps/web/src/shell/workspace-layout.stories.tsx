import { Button } from '@luma/ui/components/primitives/button';
import { PageTitle } from '@luma/ui/components/workspace/page-header';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { Plus } from 'lucide-react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { MINIMAL_VIEWPORTS } from 'storybook/viewport';

import { StoryShell } from './storybook-shell';

function ShellExample({
  workspaceName = 'Northstar Commerce',
  accountName = 'Alex Morgan',
  action,
}: {
  workspaceName?: string;
  accountName?: string;
  /** Label of a page-level action shown in the workspace bar. */
  action?: string;
}) {
  return (
    <StoryShell workspace={workspaceName} account={accountName}>
      {(page) => (
        <PageTitle
          title={page}
          actions={
            action ? (
              <Button>
                <Plus aria-hidden="true" /> {action}
              </Button>
            ) : undefined
          }
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
    const navigation = within(
      canvas.getByRole('navigation', { name: 'Workspace navigation' }),
    );
    const records = navigation.getByRole('button', {
      name: 'Records',
    });
    await expect(records).toHaveAttribute('aria-expanded', 'false');
    await expect(
      navigation.queryByRole('link', { name: 'Orders' }),
    ).not.toBeInTheDocument();
    records.focus();
    await userEvent.keyboard('{Enter}');
    await expect(records).toHaveAttribute('aria-expanded', 'true');
    await userEvent.click(navigation.getByRole('link', { name: 'Orders' }));
    await expect(
      navigation.getByRole('link', { name: 'Orders' }),
    ).toHaveAttribute('aria-current', 'page');
    await expect(
      navigation.getByRole('button', { name: 'Records' }),
    ).toHaveAttribute('aria-expanded', 'true');
    await userEvent.click(navigation.getByRole('link', { name: /^Issues/ }));
    await expect(canvas.getByRole('heading', { name: 'Issues' })).toBeVisible();
    await expect(
      within(canvas.getByRole('navigation', { name: 'Breadcrumb' })).getByText(
        'Issues',
      ),
    ).toBeVisible();
    await expect(
      navigation.getByRole('link', { name: /^Issues/ }),
    ).toHaveAttribute('aria-current', 'page');
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

export const PageAction: Story = {
  args: { action: 'New purchase order' },
  play: async ({ canvasElement }) => {
    const action = within(canvasElement).getByRole('button', {
      name: 'New purchase order',
    });
    await expect(action.closest('.desk-header')).not.toBeNull();
  },
};

export const PageActionMobile: Story = {
  args: { action: 'New purchase order' },
  globals: { viewport: { value: 'mobile1', isRotated: false } },
};

export const Mobile: Story = {
  globals: { viewport: { value: 'mobile1', isRotated: false } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const menu = canvas.getByRole('button', { name: 'Menu' });
    await userEvent.click(menu);
    const body = within(canvasElement.ownerDocument.body);
    const dialog = await body.findByRole('dialog');
    await userEvent.click(
      within(dialog).getByRole('link', { name: 'Manage apps' }),
    );
    await expect(
      canvas.getByRole('heading', { name: 'Manage apps' }),
    ).toBeVisible();
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
    // The drawer slides in from the left; measure once it has settled.
    await waitFor(() =>
      expect(dialog.getBoundingClientRect().x).toBeGreaterThanOrEqual(0),
    );
    const bounds = dialog.getBoundingClientRect();
    await expect(bounds.y).toBeGreaterThanOrEqual(0);
    await expect(bounds.right).toBeLessThanOrEqual(window.innerWidth);
  },
};
