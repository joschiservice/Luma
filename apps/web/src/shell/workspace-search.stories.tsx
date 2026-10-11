import type { Meta, StoryObj } from '@storybook/react-vite';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { useState } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';

import { contextFixture } from '../kit/identity/context.fixture';
import { contextOptions } from '../kit/identity/data';
import appStyles from '../styles.css?inline';
import { WorkspaceSearch } from './workspace-search';

function SearchExample() {
  const [client] = useState(() => {
    const value = new QueryClient();
    value.setQueryData(
      contextOptions('demo').queryKey,
      contextFixture('demo', 'owner'),
    );

    return value;
  });
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

  return (
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
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
        name: 'Open search',
      }),
    );
    const body = within(canvasElement.ownerDocument.body);
    const input = await body.findByRole('textbox', {
      name: 'Search workspace',
    });
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
    await userEvent.type(input, 'zz');
    await expect(body.getByRole('status')).toHaveTextContent('No matches');
    // A longer query can become a question for Luma.
    await userEvent.type(input, 'zz late orders');
    await expect(
      body.getByRole('button', { name: /Ask Luma.*Ask “zzzz late orders”/ }),
    ).toBeVisible();
    await userEvent.keyboard('{Escape}');
    const trigger = within(canvasElement).getByRole('button', {
      name: 'Open search',
    });
    await waitFor(() => expect(trigger).toHaveFocus());
    await userEvent.click(trigger);
    await expect(await body.findByRole('textbox')).toHaveValue('');
  },
};

export const Dark: Story = { ...Open, globals: { theme: 'dark' } };
