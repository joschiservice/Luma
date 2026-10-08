import type { Meta, StoryObj } from '@storybook/react-vite';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { type PropsWithChildren, useEffect, useState } from 'react';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';

import { ContactFormExample } from './contact-form';

function QuerySandbox({ children }: PropsWithChildren) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { retry: false },
          mutations: { retry: false },
        },
      }),
  );
  useEffect(() => () => client.clear(), [client]);

  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const meta = {
  title: 'Examples/Validated contact form',
  component: ContactFormExample,
  args: { saveContact: fn(async () => ({ kind: 'saved' })) },
  decorators: [
    (Story) => (
      <QuerySandbox>
        <Story />
      </QuerySandbox>
    ),
  ],
} satisfies Meta<typeof ContactFormExample>;

export default meta;

type Story = StoryObj<typeof meta>;

async function fillAndSubmit(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  await userEvent.type(
    canvas.getByRole('textbox', { name: 'Name' }),
    '  Ada Lovelace  ',
  );
  await userEvent.type(
    canvas.getByRole('textbox', { name: 'Email' }),
    'ada@example.com',
  );
  await userEvent.click(canvas.getByRole('button', { name: 'Save contact' }));
}

export const ValidatedSubmit: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const name = canvas.getByRole('textbox', { name: 'Name' });
    const email = canvas.getByRole('textbox', { name: 'Email' });
    const submit = canvas.getByRole('button', { name: 'Save contact' });
    await userEvent.click(submit);
    await expect(args.saveContact).not.toHaveBeenCalled();
    await expect(name).toBeInvalid();
    await expect(name).toHaveFocus();
    await expect(name).toHaveAccessibleDescription(
      'Use at least 2 characters.',
    );
    await userEvent.type(email, 'not-an-email');
    await userEvent.click(submit);
    await expect(args.saveContact).not.toHaveBeenCalled();
    await expect(email).toBeInvalid();
    await userEvent.clear(email);
    await fillAndSubmit(canvasElement);
    await expect(await canvas.findByRole('status')).toHaveTextContent(
      'Contact saved.',
    );
    await expect(args.saveContact).toHaveBeenCalledTimes(1);
    await expect(args.saveContact).toHaveBeenCalledWith({
      name: 'Ada Lovelace',
      email: 'ada@example.com',
    });
    await expect(name).not.toBeInvalid();
    await expect(email).not.toBeInvalid();
    // Changing the local draft clears feedback for the previous server result.
    await userEvent.type(name, ' Byron');
    await waitFor(() =>
      expect(canvas.queryByRole('status')).not.toBeInTheDocument(),
    );
  },
};

export const Invalid: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByRole('textbox', { name: 'Name' }), '   ');
    await userEvent.type(
      canvas.getByRole('textbox', { name: 'Email' }),
      'not-an-email',
    );
    await userEvent.click(canvas.getByRole('button', { name: 'Save contact' }));
    await expect(canvas.getAllByRole('alert')).toHaveLength(2);
    await expect(args.saveContact).not.toHaveBeenCalled();
  },
};

export const Pending: Story = {
  args: { saveContact: fn(() => new Promise<never>(() => {})) },
  play: async ({ canvasElement, args }) => {
    await fillAndSubmit(canvasElement);
    const canvas = within(canvasElement);
    const submit = await canvas.findByRole('button', { name: 'Saving…' });
    await expect(submit).toBeDisabled();
    await expect(submit).toHaveAttribute('aria-busy', 'true');
    await expect(canvas.getByRole('textbox', { name: 'Name' })).toBeDisabled();
    await userEvent.click(submit);
    await expect(args.saveContact).toHaveBeenCalledTimes(1);
  },
};

export const Conflict: Story = {
  args: { saveContact: fn(async () => ({ kind: 'email-conflict' })) },
  play: async ({ canvasElement }) => {
    await fillAndSubmit(canvasElement);
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('alert')).toHaveTextContent(
      'This email address is already in use.',
    );
    await expect(canvas.getByRole('textbox', { name: 'Email' })).toHaveValue(
      'ada@example.com',
    );
  },
};

export const RequestFailure: Story = {
  args: {
    saveContact: fn(async () => {
      throw new Error('Internal transport detail');
    }),
  },
  play: async ({ canvasElement, args }) => {
    await fillAndSubmit(canvasElement);
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('alert')).toHaveTextContent(
      'Your change couldn’t be saved. Check your connection and try again.',
    );
    await expect(
      canvas.queryByText('Internal transport detail'),
    ).not.toBeInTheDocument();
    await expect(canvas.getByRole('textbox', { name: 'Email' })).toHaveValue(
      'ada@example.com',
    );
    await userEvent.click(canvas.getByRole('button', { name: 'Save contact' }));
    await waitFor(() => expect(args.saveContact).toHaveBeenCalledTimes(2));
  },
};

export const InvalidResponse: Story = {
  args: { saveContact: fn(async () => ({ kind: 'unknown' })) },
  play: async ({ canvasElement }) => {
    await fillAndSubmit(canvasElement);
    await expect(
      await within(canvasElement).findByRole('alert'),
    ).toHaveTextContent(
      'Your change couldn’t be saved. Check your connection and try again.',
    );
  },
};

export const Dark: Story = { globals: { theme: 'dark' } };
