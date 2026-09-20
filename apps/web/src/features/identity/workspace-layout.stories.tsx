import { WorkspaceAccountMenu } from '@luma/ui/components/workspace-account-menu';
import { figmaDesign, figmaScreen } from '@luma/ui/lib/figma';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { Inbox, LayoutDashboard, Unplug } from 'lucide-react';
import { useState } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { MINIMAL_VIEWPORTS } from 'storybook/viewport';

import appStyles from '../../styles.css?inline';
import { Brand } from './common';
import { WorkspaceLayout } from './workspace-layout';

function ShellExample({
  workspaceName = 'Northstar Commerce',
  accountName = 'Alex Morgan',
}: {
  workspaceName?: string;
  accountName?: string;
}) {
  const [page, setPage] = useState('Overview');
  const [workspace, setWorkspace] = useState(workspaceName);

  return (
    <>
      {/* Mount app-wide styles only while an app story is visible. */}
      <style>{appStyles}</style>
      <WorkspaceLayout
        brand={<Brand />}
        navigation={(close) => (
          <nav aria-label="Workspace navigation">
            {['Overview', 'Issues', 'Connections'].map((label) => (
              <a
                key={label}
                href={`#${label.toLowerCase()}`}
                aria-current={page === label ? 'page' : undefined}
                className={page === label ? 'active' : undefined}
                onClick={(event) => {
                  event.preventDefault();
                  setPage(label);
                  close?.();
                }}
              >
                {label === 'Overview' ? (
                  <LayoutDashboard size={18} />
                ) : label === 'Issues' ? (
                  <Inbox size={18} />
                ) : (
                  <Unplug size={18} />
                )}
                {label}
              </a>
            ))}
          </nav>
        )}
        context={
          <>
            <span>Operations</span>
            <span>/</span>
            <span>{page}</span>
          </>
        }
        accountMenu={
          <WorkspaceAccountMenu
            name={accountName}
            workspace={workspace}
            workspaceId={workspace}
            workspaces={[workspaceName, 'Northstar Europe'].map((name) => ({
              id: name,
              name,
              link: (
                <a
                  href="#workspace"
                  onClick={(event) => {
                    event.preventDefault();
                    setWorkspace(name);
                  }}
                />
              ),
            }))}
            createLink={<a href="#create-workspace" />}
            switchLink={<a href="#workspaces" />}
          />
        }
      >
        <h1>{page}</h1>
        <p className="desk-intro">
          Review your operations, investigate issues, and manage connections.
        </p>
      </WorkspaceLayout>
    </>
  );
}

const meta = {
  title: 'App/Workspace shell',
  component: ShellExample,
  parameters: {
    layout: 'fullscreen',
    design: figmaDesign('shell'),
    viewport: { options: MINIMAL_VIEWPORTS },
  },
} satisfies Meta<typeof ShellExample>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Desktop: Story = {
  parameters: { design: figmaScreen('desktop') },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('link', { name: 'Issues' }));
    await expect(canvas.getByRole('heading', { name: 'Issues' })).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'Issues' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await userEvent.click(
      canvas.getByRole('button', { name: /Open account menu/ }),
    );
    const body = within(canvasElement.ownerDocument.body);
    await userEvent.click(
      await body.findByRole('menuitem', { name: 'Northstar Europe' }),
    );
    await expect(
      canvas.getByRole('button', { name: /Alex Morgan, Northstar Europe/ }),
    ).toBeVisible();
    await userEvent.click(
      canvas.getByRole('button', { name: /Open account menu/ }),
    );
    await waitFor(() =>
      expect(body.getByRole('menuitem', { name: 'Sign out' })).toBeVisible(),
    );
    await userEvent.keyboard('{Escape}');
    await waitFor(() =>
      expect(
        canvas.getByRole('button', { name: /Open account menu/ }),
      ).toHaveFocus(),
    );
  },
};

export const Dark: Story = {
  globals: { theme: 'dark' },
  parameters: { design: figmaScreen('dark') },
};

export const LongNames: Story = {
  parameters: { design: figmaScreen('longNames') },
  args: {
    workspaceName:
      'Northstar Commerce — International Operations and Fulfilment',
    accountName: 'Alexandra Morgan-Sutherland',
  },
};

export const Mobile: Story = {
  parameters: { design: figmaScreen('mobile') },
  globals: { viewport: { value: 'mobile1', isRotated: false } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const menu = canvas.getByRole('button', { name: 'Menu' });
    await userEvent.click(menu);
    const body = within(canvasElement.ownerDocument.body);
    const dialog = await body.findByRole('dialog');
    await userEvent.click(
      within(dialog).getByRole('link', { name: 'Connections' }),
    );
    await expect(
      canvas.getByRole('heading', { name: 'Connections' }),
    ).toBeVisible();
    await waitFor(() =>
      expect(body.queryByRole('dialog')).not.toBeInTheDocument(),
    );
    await waitFor(() => expect(menu).toHaveFocus());
  },
};

export const MobileDrawer: Story = {
  parameters: { design: figmaScreen('navigationOpen') },
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
