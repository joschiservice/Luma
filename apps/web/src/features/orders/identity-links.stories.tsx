import type { IdentityDetail } from '@luma/api-contract';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';

import appStyles from '../../styles.css?inline';
import { IdentityLinksView } from '../sync/identity-links';

const shop = '44444444-4444-4444-8444-444444444444';
const erp = '55555555-5555-4555-8555-555555555555';
const orderId = '66666666-6666-4666-8666-666666666666';
const otherId = '77777777-7777-4777-8777-777777777777';
const sources: IdentityDetail['sources'] = [
  {
    connectionId: shop,
    connectionLabel: 'Tokyo store',
    provider: 'shopify',
    externalId: 'gid://shopify/Order/1001',
    scopeKey: '',
    method: 'Imported source record',
    linkedAt: '2026-09-30T08:00:00Z',
    revisedAt: null,
    codes: [],
    titles: [],
    order: {
      number: '#1001',
      externalNumber: null,
      placedAt: '2026-09-01T09:00:00Z',
      total: { amount: '48.00', currency: 'EUR' },
    },
  },
  {
    connectionId: erp,
    connectionLabel: 'JTL-Wawi',
    provider: 'jtl',
    externalId: '10',
    scopeKey: '',
    method: 'Linked by a person',
    linkedAt: '2026-09-30T08:00:00Z',
    revisedAt: '2026-09-30T08:05:00Z',
    codes: [],
    titles: [],
    order: {
      number: 'SO-10',
      externalNumber: '#1001',
      placedAt: '2026-09-01T09:05:00Z',
      total: { amount: '48', currency: 'EUR' },
    },
  },
];

function Preview({
  state = 'suggested',
  canManage = true,
}: {
  state?: 'suggested' | 'ambiguous' | 'linked' | 'running' | 'failed';
  canManage?: boolean;
}) {
  const [sent, setSent] = useState(false);
  const linked = state === 'linked';
  const busy = state === 'running' || sent;
  const detail: IdentityDetail = {
    entity: { id: orderId, kind: 'order', label: '#1001' },
    sources: linked ? sources : [sources[0]!],
    suggestions: linked
      ? []
      : [
          {
            id: otherId,
            label: 'SO-10',
            reason: 'ERP external order number “#1001” matches Shopify',
            sources: [sources[1]!],
          },
          ...(state === 'ambiguous'
            ? [
                {
                  id: '88888888-8888-4888-8888-888888888888',
                  label: 'SO-11',
                  reason: 'ERP external order number “#1001” matches Shopify',
                  sources: [
                    {
                      ...sources[1]!,
                      externalId: '11',
                      order: {
                        number: 'SO-11',
                        externalNumber: '#1001',
                        placedAt: null,
                        total: null,
                      },
                    },
                  ],
                },
              ]
            : []),
        ],
    requests:
      busy || state === 'failed'
        ? [
            {
              id: otherId,
              kind: 'order',
              operation: 'link',
              entityId: orderId,
              otherId,
              connectionId: null,
              reason: 'Confirmed source reference',
              state: state === 'failed' ? 'failed' : 'running',
              message:
                state === 'failed'
                  ? 'Luma could not apply this change. Try again.'
                  : null,
              createdAt: '2026-09-30T08:05:00Z',
              completedAt: null,
            },
          ]
        : [],
    canManage,
  };

  return (
    <>
      <style>{appStyles}</style>
      <main className="order-page">
        <IdentityLinksView detail={detail} submit={() => setSent(true)} />
      </main>
    </>
  );
}

const meta = {
  title: 'Orders/Linked sources',
  component: Preview,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof Preview>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Suggested: Story = {};

export const Ambiguous: Story = { args: { state: 'ambiguous' } };

export const Linked: Story = { args: { state: 'linked' } };

export const Applying: Story = { args: { state: 'running' } };

export const Failed: Story = { args: { state: 'failed' } };

export const Member: Story = { args: { canManage: false } };

export const ConfirmMatch: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: /^Link$/ }));
    const dialog = within(document.body).getByRole('dialog');
    await expect(
      within(dialog).getByRole('button', { name: 'Link records' }),
    ).toBeDisabled();
    await waitFor(async () => {
      await expect(
        within(dialog).getByText('External order number: #1001'),
      ).toBeVisible();
    });
    await userEvent.type(
      within(dialog).getByLabelText('Why is this correct?'),
      'Confirmed reference, dates and totals',
    );
    await userEvent.click(
      within(dialog).getByRole('button', { name: 'Link records' }),
    );
    await expect(
      canvas.getByText('Linking records.', { exact: false }),
    ).toBeVisible();
  },
};
