import type { AppUiProps } from '@luma/app-host/web';
import { PageHeader } from '@luma/ui/components/workspace/page-header';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { type ComponentType, lazy, Suspense, useMemo, useRef } from 'react';
import { expect, userEvent, within } from 'storybook/test';

const modules = import.meta.glob<{
  ShopifyFulfillmentRecovery: ComponentType<{
    connectionId: string;
    orderId: string;
    fulfillmentOrderId: string;
    services: AppUiProps['services'];
  }>;
}>('../../../../../packages/apps/*/src/web/fulfillment-recovery.tsx');
const load = Object.values(modules)[0];
const Recovery = load
  ? lazy(async () => ({ default: (await load()).ShopifyFulfillmentRecovery }))
  : null;
const connectionId = '11111111-1111-4111-8111-111111111111';
const orderId = 'gid://shopify/Order/2001';
const fulfillmentOrderId = 'gid://shopify/FulfillmentOrder/81';
const holdId = 'gid://shopify/FulfillmentHold/17';
const expiresAt = new Date(Date.now() + 600_000).toISOString();
const snapshot = {
  id: '22222222-2222-4222-8222-222222222222',
  observedAt: '2026-09-29T09:30:00Z',
  revision: 'revision-1',
  orderId,
  fulfillmentOrderId,
  status: 'ON_HOLD',
  requestStatus: 'UNSUBMITTED',
  locationId: 'gid://shopify/Location/1',
  locationName: 'Tokyo warehouse',
  actions: ['RELEASE_HOLD', 'MOVE'],
  holds: [
    { id: holdId, reason: 'INVENTORY_OUT_OF_STOCK', heldByRequestingApp: true },
    {
      id: 'gid://shopify/FulfillmentHold/18',
      reason: 'AWAITING_PAYMENT',
      heldByRequestingApp: false,
    },
  ],
  locations: [
    { id: 'gid://shopify/Location/2', name: 'Osaka warehouse', movable: true },
  ],
  complete: true,
  lines: [{ id: 'gid://shopify/LineItem/1', remaining: 2, total: 2 }],
};

function Preview({
  missingAccess = false,
  uncertain = false,
}: {
  missingAccess?: boolean;
  uncertain?: boolean;
}) {
  const accepted = useRef(false);
  const services = useMemo<AppUiProps['services']>(() => {
    const review = {
      id: '33333333-3333-4333-8333-333333333333',
      target: { connectionId, orderId, fulfillmentOrderId },
      choice: { capability: 'fulfillment.hold.release', holdId },
      before: snapshot,
      requesterId: 'owner',
      expiresAt,
      decisionId: '44444444-4444-4444-8444-444444444444',
      state: 'approval_required',
      acceptance: 'not_sent',
      canApprove: false,
      canExecute: false,
      message:
        'Someone else who can approve changes must approve this exact action.',
    };

    return {
      install: async () => {
        throw new Error('Unavailable');
      },
      rotate: async () => {
        throw new Error('Unavailable');
      },
      error: () => 'Unable to load Shopify details.',
      uncertain: () => false,
      request: async (path) => {
        if (path.endsWith('-inspect'))
          return {
            snapshot,
            granted: missingAccess
              ? []
              : ['fulfillment.hold.release', 'fulfillment.move'],
            runs: uncertain
              ? [
                  {
                    ...review,
                    state: 'uncertain',
                    acceptance: 'unknown',
                    message:
                      'The write outcome is uncertain. Check Shopify before attempting another recovery; Luma will not resend this action.',
                  },
                ]
              : [],
          };
        if (path.endsWith('-preview')) return review;
        if (path.endsWith('-execute')) {
          accepted.current = true;

          return {
            ...review,
            state: 'recovery_required',
            acceptance: 'accepted',
            message:
              'Shopify accepted the action. Fulfillment progress is not yet verified.',
          };
        }

        return accepted.current
          ? {
              ...review,
              state: 'verified',
              acceptance: 'accepted',
              message: 'Fresh Shopify evidence shows fewer unfulfilled items.',
            }
          : {
              ...review,
              canExecute: true,
              message:
                'Approved. The requester can run the action after a fresh eligibility check.',
            };
      },
    };
  }, [missingAccess, uncertain]);

  return (
    <main className="shopify-recovery-story">
      <PageHeader title="Order #2001" description="Shopify · Tokyo warehouse" />
      <Suspense fallback={<p>Loading recovery…</p>}>
        {Recovery ? (
          <Recovery
            connectionId={connectionId}
            orderId={orderId}
            fulfillmentOrderId={fulfillmentOrderId}
            services={services}
          />
        ) : null}
      </Suspense>
    </main>
  );
}

const meta = {
  title: 'Orders/Shopify fulfillment recovery',
  component: Preview,
  parameters: { layout: 'padded' },
} satisfies Meta<typeof Preview>;

export default meta;

type Story = StoryObj<typeof meta>;

export const HeldOrder: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      await canvas.findByRole(
        'button',
        { name: 'Preview recovery' },
        { timeout: 10000 },
      ),
    );
    await expect(await canvas.findByText('Release hold 17 only')).toBeVisible();
    await expect(
      canvas.queryByRole('button', { name: 'Send to Shopify' }),
    ).not.toBeInTheDocument();
    await userEvent.click(
      canvas.getByRole('button', { name: 'Check approval' }),
    );
    await userEvent.click(
      await canvas.findByRole('button', { name: 'Send to Shopify' }),
    );
    await expect(
      await canvas.findByText('Shopify accepted', { exact: true }),
    ).toBeVisible();
    await expect(canvas.getByText('Progress not verified')).toBeVisible();
    await userEvent.click(
      canvas.getByRole('button', { name: 'Check fulfillment progress' }),
    );
    await expect(await canvas.findByText('Progress verified')).toBeVisible();
  },
};

export const Dark: Story = { globals: { theme: 'dark' } };

export const MissingAccess: Story = {
  args: { missingAccess: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole(
        'button',
        { name: 'Preview recovery' },
        { timeout: 10000 },
      ),
    ).toBeDisabled();
  },
};

export const Uncertain: Story = {
  args: { uncertain: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByText('Outcome unclear', undefined, {
        timeout: 10000,
      }),
    ).toBeVisible();
    await expect(
      canvas.queryByRole('button', { name: 'Send to Shopify' }),
    ).not.toBeInTheDocument();
  },
};
