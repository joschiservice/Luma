import type { AppUiProps } from '@luma/app-host/web';
import { PageHeader } from '@luma/ui/components/workspace/page-header';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { type ComponentType, useMemo, useRef } from 'react';
import { expect, userEvent, within } from 'storybook/test';

const modules = import.meta.glob<{
  ShopifyOrderEdits: ComponentType<{
    connectionId: string;
    orderId: string;
    services: AppUiProps['services'];
    headingLevel?: 2 | 3 | 4;
  }>;
}>('../../../../../packages/apps/*/src/web/order-edits.tsx');
const load = Object.values(modules)[0];
// Import the app while the story file loads: its first Vite compile can outlast a story's
// test time limit in parallel runs, and story loaders count toward that limit.
const Edits = load ? (await load()).ShopifyOrderEdits : null;
const connectionId = '11111111-1111-4111-8111-111111111111';
const orderId = 'gid://shopify/Order/2001';
const tote = 'gid://shopify/LineItem/1';
const shirt = 'gid://shopify/LineItem/2';
const expiresAt = new Date(Date.now() + 600_000).toISOString();
const bag = (shop: string, presentment: string) => ({
  shop: { amount: shop, currencyCode: 'EUR' },
  presentment: { amount: presentment, currencyCode: 'CHF' },
});
const snapshot = {
  id: '22222222-2222-4222-8222-222222222222',
  observedAt: '2026-10-12T09:30:00Z',
  revision: 'a'.repeat(64),
  updatedAt: '2026-10-12T09:00:00Z',
  orderId,
  cancelled: false,
  closed: false,
  totals: {
    subtotal: bag('110.00', '104.50'),
    total: bag('110.00', '104.50'),
    outstanding: bag('0.00', '0.00'),
  },
  lines: [
    {
      id: tote,
      name: 'Canvas tote - Natural',
      sku: 'TOTE-NAT',
      quantity: 3,
      currentQuantity: 3,
      unfulfilledQuantity: 3,
    },
    {
      id: shirt,
      name: 'Linen shirt',
      sku: 'SHIRT-M',
      quantity: 1,
      currentQuantity: 1,
      unfulfilledQuantity: 0,
    },
  ],
  fulfillmentOrders: [
    {
      id: 'gid://shopify/FulfillmentOrder/81',
      status: 'OPEN',
      requestStatus: 'UNSUBMITTED',
      lines: [{ lineItemId: tote, remaining: 3, total: 3 }],
    },
    {
      id: 'gid://shopify/FulfillmentOrder/82',
      status: 'CLOSED',
      requestStatus: 'UNSUBMITTED',
      lines: [{ lineItemId: shirt, remaining: 0, total: 1 }],
    },
  ],
  complete: true,
};
const calculation = {
  id: '55555555-5555-4555-8555-555555555555',
  observedAt: '2026-10-12T09:30:01Z',
  subtotal: bag('70.00', '66.50'),
  total: bag('70.00', '66.50'),
  outstanding: bag('0.00', '0.00'),
  lines: [
    { lineItemId: tote, quantity: 1 },
    { lineItemId: shirt, quantity: 1 },
  ],
};

type Stage = 'compose' | 'approve' | 'uncertain' | 'observe';

function Preview({ stage = 'compose' }: { stage?: Stage }) {
  const sent = useRef(false);
  const services = useMemo<AppUiProps['services']>(() => {
    const review = {
      id: '33333333-3333-4333-8333-333333333333',
      target: { connectionId, orderId },
      change: { lines: [{ lineItemId: tote, quantity: 1 }], restock: true },
      lines: [{ lineItemId: tote, currentQuantity: 3, quantity: 1 }],
      before: snapshot,
      calculation: stage === 'observe' ? null : calculation,
      authority: { revision: 4, state: 'resolved', connectionId },
      onHold: false,
      requesterId: 'owner',
      expiresAt,
      decisionId: '44444444-4444-4444-8444-444444444444',
      state: 'approval_required',
      approved: false,
      denial: null,
      acceptance: 'not_sent',
      observeOnly: stage === 'observe',
      canApprove: stage === 'approve',
      canExecute: false,
      message: '',
    };
    const saved =
      stage === 'uncertain'
        ? { ...review, state: 'uncertain', acceptance: 'unknown' }
        : stage === 'compose'
          ? null
          : review;

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
        if (path.endsWith('-recent')) return { runs: saved ? [saved] : [] };
        if (path.endsWith('-inspect'))
          return {
            snapshot,
            granted: ['orders.read', 'orders.quantity.edit'],
            authority: { revision: 4, state: 'resolved', connectionId },
            observeOnly: stage === 'observe',
            runs: saved ? [saved] : [],
          };
        if (path.endsWith('-preview')) return review;
        if (path.endsWith('-approve'))
          return {
            ...review,
            approved: true,
            canApprove: false,
          };
        if (path.endsWith('-execute')) {
          sent.current = true;

          return {
            ...review,
            approved: true,
            state: 'recovery_required',
            acceptance: 'accepted',
          };
        }

        return sent.current || stage === 'uncertain'
          ? {
              ...review,
              approved: true,
              state: 'verified',
              acceptance: 'accepted',
            }
          : { ...review, approved: true, canExecute: true };
      },
    };
  }, [stage]);

  return (
    <main className="shopify-order-edit-story">
      <PageHeader title="Order #2001" description="Shopify · Live details" />
      {Edits ? (
        <Edits
          connectionId={connectionId}
          orderId={orderId}
          services={services}
          headingLevel={2}
        />
      ) : null}
    </main>
  );
}

const meta = {
  title: 'Orders/Shopify order quantity edits',
  component: Preview,
  parameters: { layout: 'padded' },
} satisfies Meta<typeof Preview>;

export default meta;

type Story = StoryObj<typeof meta>;

export const ChangeQuantities: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      await canvas.findByRole('button', { name: 'Change quantities…' }),
    );
    // A shipped line cannot change; its field explains why.
    await expect(
      await canvas.findByRole('spinbutton', {
        name: 'New quantity for Linen shirt',
      }),
    ).toBeDisabled();
    await expect(
      canvas.getByText('Some units are already fulfilled.'),
    ).toBeVisible();
    const preview = canvas.getByRole('button', { name: 'Preview change' });
    await expect(preview).toBeDisabled();
    await userEvent.type(
      canvas.getByRole('spinbutton', {
        name: 'New quantity for Canvas tote - Natural',
      }),
      '1',
    );
    await userEvent.click(preview);
    await expect(
      await canvas.findByText('Canvas tote - Natural: 3 → 1'),
    ).toBeVisible();
    await expect(canvas.getByText('Awaiting approval')).toBeVisible();
    await expect(
      canvas.queryByRole('button', { name: 'Send to Shopify' }),
    ).not.toBeInTheDocument();
    await userEvent.click(
      canvas.getByRole('button', { name: 'Check approval' }),
    );
    await userEvent.click(
      await canvas.findByRole('button', { name: 'Send to Shopify' }),
    );
    await expect(await canvas.findByText('Accepted by Shopify')).toBeVisible();
    await expect(canvas.getByText('Not verified')).toBeVisible();
    await userEvent.click(
      canvas.getByRole('button', { name: 'Check Shopify' }),
    );
    await expect(await canvas.findByText('Verified')).toBeVisible();
  },
};

export const Dark: Story = {
  args: { stage: 'approve' },
  globals: { theme: 'dark' },
};

export const Narrow: Story = {
  args: { stage: 'compose' },
  globals: { viewport: { value: 'mobile1', isRotated: false } },
};

export const ApproverReview: Story = {
  args: { stage: 'approve' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole('button', { name: 'Approve' }),
    ).toBeVisible();
    await expect(
      canvas.getByText('Removed units are restocked.'),
    ).toBeVisible();
    await expect(
      canvas.getByRole('table', { name: 'Order totals' }),
    ).toBeVisible();
  },
};

export const UncertainCommit: Story = {
  args: { stage: 'uncertain' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByText('Sent, outcome unknown'),
    ).toBeVisible();
    await expect(
      canvas.queryByRole('button', { name: 'Send to Shopify' }),
    ).not.toBeInTheDocument();
  },
};

export const ObserveOnly: Story = {
  args: { stage: 'observe' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByText(
        'Shopify did not calculate the new totals because writes are off.',
      ),
    ).toBeVisible();
    await expect(
      canvas.getByText('Not executed: writes are off'),
    ).toBeVisible();
  },
};
