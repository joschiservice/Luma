import './settings.css';

import type { Meta, StoryObj } from '@storybook/react-vite';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';

import appStyles from '../../styles.css?inline';
import { SecuritySettings } from './security';

type SecurityState = 'off' | 'on' | 'unavailable';

const totpURI =
  'otpauth://totp/Luma:avery%40example.test?secret=MFRGGZDFMZTWQ2LKNNWG23TPOBYXE43UOV3HO6DZPI&issuer=Luma&digits=6&period=30';

const backupCodes = Array.from(
  { length: 10 },
  (_, index) => `k7q${index}m-x2p${index}d`,
);

/** Answers the auth routes Settings → Security reads, without leaving the preview. */
function mockSecurity(state: SecurityState = 'off') {
  const original = globalThis.fetch;
  let enabled = state === 'on';
  globalThis.fetch = async (input, init) => {
    const url = new URL(
      input instanceof Request ? input.url : String(input),
      location.origin,
    );
    if (!url.pathname.startsWith('/api/')) return original(input, init);
    const path = url.pathname.replace('/api/auth', '');
    if (path === '/get-session')
      return Response.json({
        session: { id: 'session', userId: 'user', expiresAt: '2026-11-01' },
        user: {
          id: 'user',
          name: 'Avery Stone',
          email: 'avery@example.test',
          twoFactorEnabled: enabled,
        },
      });
    if (path === '/passkey/list-user-passkeys')
      return state === 'unavailable'
        ? Response.json({ message: 'Unavailable' }, { status: 503 })
        : Response.json(
            state === 'on'
              ? [
                  {
                    id: 'passkey-1',
                    name: 'Work laptop',
                    deviceType: 'multiDevice',
                    backedUp: true,
                    createdAt: '2026-09-28T08:12:00Z',
                  },
                  {
                    id: 'passkey-2',
                    name: null,
                    deviceType: 'singleDevice',
                    backedUp: false,
                    createdAt: '2026-10-02T15:40:00Z',
                  },
                ]
              : [],
          );
    if (path === '/two-factor/enable')
      return Response.json({ method: 'totp', totpURI, backupCodes });
    if (path === '/two-factor/verify-totp') {
      enabled = true;

      return Response.json({ token: 'token', user: { id: 'user' } });
    }

    return Response.json({ message: 'Not mocked' }, { status: 503 });
  };

  return () => {
    globalThis.fetch = original;
  };
}

function Preview() {
  const [client] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  );

  return (
    <QueryClientProvider client={client}>
      <style>{appStyles}</style>
      {/* Skip the page entry animation so play assertions see settled content. */}
      <div
        className="settings-content"
        style={{ padding: 24, animation: 'none' }}
      >
        <SecuritySettings disabled={false} />
      </div>
    </QueryClientProvider>
  );
}

const meta = {
  title: 'Settings/Security',
  component: Preview,
  parameters: { layout: 'fullscreen' },
  beforeEach: (context) =>
    mockSecurity(context.parameters.security as SecurityState | undefined),
} satisfies Meta<typeof Preview>;

export default meta;

type Story = StoryObj<typeof meta>;

export const NotSetUp: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const page = within(canvasElement.ownerDocument.body);
    await expect(await canvas.findByText('None added')).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Set up' }));
    await userEvent.type(page.getByLabelText('Password'), 'correct horse');
    await userEvent.click(page.getByRole('button', { name: 'Continue' }));
    await expect(
      await page.findByRole('list', { name: 'Backup codes' }),
    ).toBeVisible();
    await userEvent.click(
      page.getByRole('button', { name: 'I’ve saved my codes' }),
    );
    await expect(
      page.getByRole('img', { name: 'QR code for your authenticator app' }),
    ).toBeVisible();
    await userEvent.type(page.getByLabelText('Authentication code'), '123456');
    await userEvent.click(page.getByRole('button', { name: 'Turn on' }));
    await waitFor(() => expect(canvas.getByText('On')).toBeVisible());
  },
};

export const Enabled: Story = {
  parameters: { security: 'on' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole('list', { name: 'Your passkeys' }),
    ).toBeVisible();
    await expect(
      canvas.getByRole('button', { name: 'Remove Work laptop' }),
    ).toBeEnabled();
  },
};

export const EnabledDark: Story = {
  parameters: { security: 'on' },
  globals: { theme: 'dark' },
};

export const PasskeysUnavailable: Story = {
  parameters: { security: 'unavailable' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByText(/Passkeys could not be loaded/),
    ).toBeVisible();
  },
};
