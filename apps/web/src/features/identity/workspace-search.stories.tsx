import type { Meta, StoryObj } from '@storybook/react-vite';
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { useState } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';

import appStyles from '../../styles.css?inline';
import { WorkspaceSearch } from './workspace-search';

function SearchExample() {
  const [router] = useState(() =>
    createRouter({
      history: createMemoryHistory(),
      routeTree: createRootRoute({
        component: () => (
          <>
            <style>{appStyles}</style>
            <WorkspaceSearch organizationId="demo" />
          </>
        ),
      }),
    }),
  );

  return <RouterProvider router={router} />;
}

const meta = {
  title: 'App/Workspace search',
  component: SearchExample,
} satisfies Meta<typeof SearchExample>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Open: Story = {
  play: async ({ canvasElement }) => {
    await userEvent.click(
      await within(canvasElement).findByRole('button', {
        name: 'Search pages',
      }),
    );
    const body = within(canvasElement.ownerDocument.body);
    const input = await body.findByRole('textbox', { name: 'Search pages' });
    await waitFor(() => expect(input).toHaveFocus());
    await userEvent.keyboard('{ArrowDown}');
    await expect(body.getByRole('link', { name: /^Home/ })).toHaveFocus();
    await userEvent.keyboard('{ArrowUp}');
    await expect(input).toHaveFocus();
    await userEvent.type(input, 'workflow');
    await expect(body.getByRole('link', { name: /Workflows/ })).toBeVisible();
    await expect(
      body.queryByRole('link', { name: /^Home/ }),
    ).not.toBeInTheDocument();
    await userEvent.clear(input);
    await userEvent.type(input, 'zzzz');
    await expect(body.getByRole('status')).toHaveTextContent('No pages found');
    await userEvent.keyboard('{Escape}');
    const trigger = within(canvasElement).getByRole('button', {
      name: 'Search pages',
    });
    await waitFor(() => expect(trigger).toHaveFocus());
    await userEvent.click(trigger);
    await expect(await body.findByRole('textbox')).toHaveValue('');
  },
};

export const Dark: Story = { ...Open, globals: { theme: 'dark' } };
