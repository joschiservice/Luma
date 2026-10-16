import type { AppUiProps } from '@luma/app-host/web';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { type ComponentType } from 'react';
import { expect, userEvent, within } from 'storybook/test';

const modules = import.meta.glob<{ default: ComponentType<AppUiProps> }>(
  '../../../../../packages/apps/*/src/web/index.tsx',
);
const load = Object.entries(modules).find(([path]) =>
  path.includes('/shopify/'),
)?.[1];
// Import the app while the story file loads: its first Vite compile can outlast a story's
// test time limit in parallel runs, and story loaders count toward that limit.
const Shopify = load ? (await load()).default : null;
const connectionId = '11111111-1111-4111-8111-111111111111';
const organizationId = '22222222-2222-4222-8222-222222222222';
const timestamp = '2026-09-28T08:00:00Z';
const gid = (kind: string) => `gid://shopify/${kind}/123`;

function Preview({ slot = 'page' }: { slot?: 'page' | 'record' }) {
  if (!Shopify) return <p>Shopify is not installed in this deployment.</p>;
  const services: AppUiProps['services'] = {
    install: async () => {
      throw new Error('Not available in this story');
    },
    rotate: async () => {
      throw new Error('Not available in this story');
    },
    error: () => 'Could not read this record. Try again.',
    uncertain: () => false,
    request: async (path, body) => {
      if (path === 'record-connections')
        return [{ id: connectionId, label: 'Tokyo store' }];
      const input = body as { kind: string; id?: string };
      const rows = input.id
        ? [
            {
              id: input.id,
              sourceUpdatedAt: timestamp,
              fields:
                input.kind === 'Order'
                  ? {
                      Name: '#1001',
                      Payment: 'PAID',
                      Fulfillment: 'ON_HOLD',
                      Total: '84.00 EUR',
                    }
                  : { Refunded: '12.00 EUR' },
              links:
                input.kind === 'Order'
                  ? [{ kind: 'Refund', id: gid('Refund'), label: 'Refund' }]
                  : [{ kind: 'Order', id: gid('Order'), label: '#1001' }],
            },
          ]
        : [
            {
              id: gid('Order'),
              sourceUpdatedAt: timestamp,
              fields: { Name: '#1001' },
              links: [{ kind: 'Order', id: gid('Order'), label: '#1001' }],
            },
          ];

      return {
        tenantId: organizationId,
        connectionId,
        shop: 'tokyo.myshopify.com',
        kind: input.kind,
        id: input.id ?? '',
        observedAt: timestamp,
        apiVersion: '2026-07',
        nextCursor: null,
        sections: [
          {
            key: 'records',
            title: input.id ? input.kind : 'Recent orders',
            status: 'available',
            requiredScopes: ['read_orders'],
            message: null,
            rows,
          },
          ...(input.kind === 'Order' && input.id
            ? [
                {
                  key: 'customer',
                  title: 'Customer',
                  status: 'approval_required',
                  requiredScopes: ['read_customers'],
                  message:
                    'Protected customer data access must be approved for this app before customer context can be read.',
                  rows: [],
                },
                {
                  key: 'returns',
                  title: 'Returns',
                  status: 'missing_scope',
                  requiredScopes: ['read_returns'],
                  message: 'Reconnect Shopify with read_returns.',
                  rows: [],
                },
                {
                  key: 'events',
                  title: 'Source events',
                  status: 'available',
                  requiredScopes: ['read_orders'],
                  message: null,
                  rows: [
                    {
                      id: 'gid://shopify/BasicEvent/987',
                      sourceUpdatedAt: null,
                      fields: { Occurred: timestamp, Action: 'confirmed' },
                      links: [],
                    },
                  ],
                },
              ]
            : []),
        ],
      };
    },
  };

  return (
    <Shopify
      organizationId={organizationId}
      slot={slot}
      can={() => true}
      record={
        slot === 'record'
          ? { kind: 'order', connectionId, externalId: gid('Order') }
          : undefined
      }
      services={services}
      done={async () => {}}
    />
  );
}

const meta = {
  title: 'Apps/Shopify records',
  component: Preview,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof Preview>;

export default meta;

type Story = StoryObj<typeof meta>;

export const BrowseAndFollowLinks: Story = {
  play: async ({ canvasElement }) => {
    if (!Shopify) return;
    const canvas = within(canvasElement);
    await userEvent.click(
      await canvas.findByRole('button', { name: 'Browse orders' }),
    );
    await userEvent.click(await canvas.findByRole('button', { name: '#1001' }));
    await expect(await canvas.findByText('84.00 EUR')).toBeVisible();
    await expect(
      canvas.getByText('Reconnect Shopify with read_returns.'),
    ).toBeVisible();
    await expect(canvas.getByText('confirmed', { exact: true })).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Refund' }));
    await expect(await canvas.findByText('12.00 EUR')).toBeVisible();
  },
};

export const Dark: Story = {
  globals: { theme: 'dark' },
  play: BrowseAndFollowLinks.play!,
};

export const OrderContext: Story = {
  args: { slot: 'record' },
  play: async ({ canvasElement }) => {
    if (!Shopify) return;
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('84.00 EUR')).toBeVisible();
    await expect(
      canvas.getByRole('link', { name: 'Open in Shopify admin' }),
    ).toHaveAttribute('href', 'https://tokyo.myshopify.com/admin/orders/123');
    await userEvent.click(canvas.getByRole('button', { name: 'Refund' }));
    await expect(await canvas.findByText('12.00 EUR')).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Back' }));
    await expect(await canvas.findByText('84.00 EUR')).toBeVisible();
  },
};
