import type { AppUiProps } from '@luma/app-host/web';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { type ComponentType, useMemo } from 'react';
import { expect, userEvent, within } from 'storybook/test';

const modules = import.meta.glob<{
  ShopifyShipmentPublishing: ComponentType<{
    connectionId: string;
    orderId: string;
    services: AppUiProps['services'];
  }>;
}>('../../../../../packages/apps/*/src/web/shipment-publishing.tsx');
const load = Object.values(modules)[0];
// Import the app while the story file loads: its first Vite compile can outlast a story's
// test time limit in parallel runs, and story loaders count toward that limit.
const Publishing = load ? (await load()).ShopifyShipmentPublishing : null;
const connectionId = '11111111-1111-4111-8111-111111111111',
  downstreamConnectionId = '22222222-2222-4222-8222-222222222222',
  orderId = 'gid://shopify/Order/2001';
const expiresAt = new Date(Date.now() + 600_000).toISOString();
const snapshot = {
  id: '33333333-3333-4333-8333-333333333333',
  observedAt: new Date().toISOString(),
  revision: 'revision-1',
  orderId,
  cancelled: false,
  complete: true,
  work: [
    {
      id: 'gid://shopify/FulfillmentOrder/81',
      status: 'OPEN',
      requestStatus: 'UNSUBMITTED',
      actions: ['CREATE_FULFILLMENT'],
      locationId: 'gid://shopify/Location/1',
      lines: [
        {
          id: 'gid://shopify/FulfillmentOrderLineItem/17',
          orderLineId: 'gid://shopify/LineItem/1',
          remaining: 3,
          total: 3,
        },
      ],
    },
  ],
  shipments: [],
  dispatch: {
    id: '44444444-4444-4444-8444-444444444444',
    observationId: '55555555-5555-4555-8555-555555555555',
    observedAt: new Date().toISOString(),
    revision: 'carrier-1',
    complete: true,
    connectionId: downstreamConnectionId,
    shipmentId: 'parcel1',
    stage: 'carrier',
    locationId: null,
    lines: [],
    tracking: [
      {
        company: 'DHL',
        number: 'PARCEL-123',
        url: 'https://tracking.example.test/123',
      },
    ],
  },
};

function Preview({
  uncertain = false,
  disabled = false,
}: {
  uncertain?: boolean;
  disabled?: boolean;
}) {
  const services = useMemo<AppUiProps['services']>(() => {
    const review = {
      id: '66666666-6666-4666-8666-666666666666',
      target: { connectionId, orderId },
      choice: {
        capability: 'fulfillment.shipment.create',
        source: { downstreamConnectionId, shipmentId: 'parcel1' },
        allocationSource: 'operator',
        notifyCustomer: false,
        allocations: [
          {
            fulfillmentOrderId: 'gid://shopify/FulfillmentOrder/81',
            fulfillmentOrderLineId: 'gid://shopify/FulfillmentOrderLineItem/17',
            orderLineId: 'gid://shopify/LineItem/1',
            locationId: 'gid://shopify/Location/1',
            quantity: 1,
          },
        ],
      },
      before: snapshot,
      requesterId: 'requester',
      expiresAt,
      decisionId: '77777777-7777-4777-8777-777777777777',
      state: 'approval_required',
      acceptance: 'not_sent',
      canApprove: true,
      canExecute: false,
      message: 'Approval required',
    };

    return {
      install: async () => {
        throw new Error('Unavailable');
      },
      rotate: async () => {
        throw new Error('Unavailable');
      },
      error: () => 'Unable to read shipping evidence.',
      uncertain: () => false,
      request: async (path) => {
        if (path.endsWith('-sources'))
          return {
            enabled: !disabled,
            sources: [
              {
                downstreamConnectionId,
                shipmentId: 'parcel1',
                label: 'Starshipit · PARCEL-123',
              },
            ],
          };
        if (path.endsWith('-inspect'))
          return {
            snapshot,
            granted: [
              'fulfillment.shipment.create',
              'fulfillment.tracking.update',
            ],
            runs: uncertain
              ? [
                  {
                    ...review,
                    state: 'uncertain',
                    acceptance: 'unknown',
                    canApprove: false,
                  },
                ]
              : [],
          };
        if (path.endsWith('-preview')) return review;
        if (path.endsWith('-approve'))
          return {
            ...review,
            canApprove: false,
            canExecute: true,
            approved: true,
          };
        if (path.endsWith('-execute'))
          return {
            ...review,
            state: 'recovery_required',
            acceptance: 'accepted',
            canApprove: false,
            canExecute: false,
          };

        return {
          ...review,
          state: 'verified',
          acceptance: 'accepted',
          canApprove: false,
          canExecute: false,
        };
      },
    };
  }, [disabled, uncertain]);

  return Publishing ? (
    <Publishing
      connectionId={connectionId}
      orderId={orderId}
      services={services}
    />
  ) : null;
}

const meta = {
  title: 'Orders/Shopify shipment publishing',
  component: Preview,
  parameters: { layout: 'padded' },
} satisfies Meta<typeof Preview>;

export default meta;

type Story = StoryObj<typeof meta>;

export const PartialParcel: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const save = await canvas.findByRole('button', {
      name: 'Save exact preview',
    });
    await expect(save).toBeDisabled();
    const quantity = await canvas.findByRole('spinbutton', {
      name: /Dispatched units for line 1/,
    });
    await userEvent.clear(quantity);
    await userEvent.type(quantity, '1');
    await userEvent.click(
      canvas.getByRole('switch', { name: /I confirm these exact items/ }),
    );
    await expect(
      canvas.getByRole('switch', { name: /Notify the customer/ }),
    ).not.toBeChecked();
    await userEvent.click(save);
    await expect(
      await canvas.findByText('Customer notification: do not send'),
    ).toBeVisible();
    await userEvent.click(
      canvas.getByRole('button', { name: 'Approve this shipment' }),
    );
    await userEvent.click(
      await canvas.findByRole('button', { name: 'Publish approved shipment' }),
    );
    await expect(
      await canvas.findByText(
        'Shopify accepted the write. The shipment is not yet independently verified.',
      ),
    ).toBeVisible();
    await userEvent.click(
      canvas.getByRole('button', { name: 'Check Shopify again' }),
    );
    await expect(
      await canvas.findByText(
        'A fresh Shopify read verified the exact allocation and tracking.',
      ),
    ).toBeVisible();
  },
};

export const Dark: Story = { globals: { theme: 'dark' } };

export const Narrow: Story = { parameters: { viewport: { value: 'mobile1' } } };

export const Uncertain: Story = {
  args: { uncertain: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByText(
        'The send outcome is unknown. Check Shopify independently; this action will not be sent again.',
      ),
    ).toBeVisible();
    await expect(
      canvas.queryByRole('button', { name: 'Publish approved shipment' }),
    ).not.toBeInTheDocument();
  },
};

export const Disabled: Story = {
  args: { disabled: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByText(
        'Shipment publishing is not enabled for this workspace.',
      ),
    ).toBeVisible();
    await expect(
      canvas.queryByRole('button', { name: 'Save exact preview' }),
    ).not.toBeInTheDocument();
  },
};
