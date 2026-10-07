import type { AppUiProps } from '@luma/app-host/web';
import { PageTitle } from '@luma/ui/components/workspace/page-header';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { type ComponentType, lazy, Suspense, useMemo } from 'react';
import { expect, userEvent, within } from 'storybook/test';

const modules = import.meta.glob<{ default: ComponentType<AppUiProps> }>(
  '../../../../../packages/apps/*/src/web/index.tsx',
);
const load = Object.entries(modules).find(([path]) =>
  path.includes('/shopify/'),
)?.[1];
const Shopify = load ? lazy(load) : null;
const organizationId = '22222222-2222-4222-8222-222222222222';
const connectionId = '11111111-1111-4111-8111-111111111111';
const customerId = 'gid://shopify/Customer/71';
const timestamp = '2026-09-28T08:00:00Z';
const customer = {
  id: customerId,
  sourceUpdatedAt: timestamp,
  fields: {
    Name: 'Avery Tan',
    Email: 'avery@example.test',
    Phone: '+81 3 1234 5678',
    Orders: '8',
    Spent: '482.00 EUR',
  },
  links: [],
};
const order = {
  id: 'gid://shopify/Order/2001',
  sourceUpdatedAt: timestamp,
  fields: {
    Name: '#2001',
    Created: timestamp,
    Payment: 'PAID',
    Fulfillment: 'FULFILLED',
    Total: '84.00 EUR',
  },
  links: [],
};

function Preview({
  detail = false,
  denied = false,
}: {
  detail?: boolean;
  denied?: boolean;
}) {
  const services = useMemo<AppUiProps['services']>(
    () => ({
      install: async () => {
        throw new Error('Unavailable');
      },
      rotate: async () => {
        throw new Error('Unavailable');
      },
      uncertain: () => false,
      error: () => 'Could not load customers. Try again.',
      orderContext: async () => ({ status: 'unmapped', order: null }),
      request: async (path, body) => {
        if (path === 'record-connections')
          return [{ id: connectionId, label: 'Tokyo store' }];
        const input = body as { kind: string; id?: string; search?: unknown };
        const sections = denied
          ? [
              {
                key: 'records',
                title: 'Customers',
                status: 'missing_scope',
                message: 'Reconnect Shopify with read_customers.',
                requiredScopes: ['read_customers'],
                rows: [],
              },
            ]
          : (input.kind === 'Order'
              ? [
                  { key: 'order', title: 'Order', rows: [order] },
                  { key: 'returns', title: 'Returns', rows: [] },
                  { key: 'refunds', title: 'Refunds', rows: [] },
                ]
              : input.id
                ? [
                    { key: 'contact', title: 'Contact', rows: [customer] },
                    { key: 'customer', title: 'Customer', rows: [customer] },
                    { key: 'orders', title: 'Customer orders', rows: [order] },
                  ]
                : [
                    {
                      key: 'records',
                      title: 'Customers',
                      rows: input.search
                        ? [
                            customer,
                            { ...customer, id: 'gid://shopify/Customer/72' },
                          ]
                        : [customer],
                    },
                  ]
            ).map((section) => ({
              ...section,
              status: 'available',
              message: null,
              requiredScopes: [],
            }));

        return {
          tenantId: organizationId,
          connectionId,
          kind: input.kind,
          id: input.id ?? '',
          shop: 'tokyo.myshopify.com',
          observedAt: timestamp,
          apiVersion: '2026-07',
          sections,
          nextCursor: null,
        };
      },
    }),
    [denied],
  );
  if (!Shopify) return null;

  return (
    <main style={{ padding: 24 }}>
      <PageTitle title="Customers" />
      <Suspense fallback={<p>Loading…</p>}>
        <Shopify
          organizationId={organizationId}
          slot="customers"
          can={() => true}
          customer={{ connectionId, id: detail ? customerId : undefined }}
          services={services}
          done={async () => {}}
        />
      </Suspense>
    </main>
  );
}

const meta = {
  title: 'Customers/Workspace',
  component: Preview,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof Preview>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Search: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole(
        'link',
        { name: 'Avery Tan' },
        { timeout: 10000 },
      ),
    ).toBeVisible();
    await userEvent.type(canvas.getByLabelText('Customer name'), 'Avery');
    await userEvent.click(canvas.getByRole('button', { name: 'Search' }));
    await expect(
      await canvas.findByText(/Multiple customer identities match/),
    ).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Clear' }));
    await expect(
      await canvas.findByRole(
        'link',
        { name: 'Avery Tan' },
        { timeout: 10000 },
      ),
    ).toBeVisible();
    await expect(canvas.getByLabelText('Customer name')).toHaveValue('');
  },
};

export const Detail: Story = {
  args: { detail: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole(
        'heading',
        { name: 'Avery Tan' },
        { timeout: 10000 },
      ),
    ).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: '#2001' }));
    await expect(await canvas.findByText(/has not been mapped/)).toBeVisible();
  },
};

export const Dark: Story = { ...Detail, globals: { theme: 'dark' } };

export const MissingAccess: Story = {
  args: { denied: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByText(
        'Reconnect Shopify with read_customers.',
        undefined,
        { timeout: 10000 },
      ),
    ).toBeVisible();
    await expect(
      canvas.queryByText('avery@example.test'),
    ).not.toBeInTheDocument();
  },
};
