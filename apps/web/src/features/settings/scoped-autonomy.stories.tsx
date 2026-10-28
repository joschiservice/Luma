import type { AutonomyPolicy } from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';

import { contextFixture } from '../../kit/identity/context.fixture';
import { contextOptions } from '../../kit/identity/data';
import appStyles from '../../styles.css?inline';
import { ScopedAutonomySettings } from './scoped-autonomy';

const organizationId = '11111111-1111-4111-8111-111111111111';
const policy: AutonomyPolicy = {
  id: '33333333-3333-4333-8333-333333333333',
  tenantId: organizationId,
  revision: 2,
  name: 'Supplier follow-up notes',
  scopeHash: 'scope',
  mode: 'assisted',
  paused: false,
  pausedConnectionIds: [],
  revoked: false,
  circuitReason: null,
  updatedAt: '2026-10-13T12:00:00Z',
  updatedBy: 'owner',
  scope: {
    capability: 'procurement.follow-up.record',
    connectionIds: [organizationId],
    supplierIds: [],
    locationIds: [],
    recordIds: [],
    unit: 'follow_up',
    perActionQuantity: '1',
    dailyQuantity: '20',
    money: null,
    maxEvidenceAgeSeconds: 300,
  },
};
const trackRecord = {
  live: 0,
  synthetic: 6,
  unknown: 2,
  reviewed: 0,
  verified: 0,
  acceptanceRate: null,
  overrideRate: null,
  reviewerAgreementRate: null,
  verificationPassRate: null,
  failures: 0,
  promotionEligible: false,
};
let requests: unknown[] = [];

function mock(state: 'ready' | 'paused' | 'lost') {
  requests = [];
  let stored =
    state === 'lost'
      ? []
      : [
          {
            ...policy,
            ...(state === 'paused'
              ? {
                  paused: true,
                  mode: 'manual',
                  circuitReason: 'uncertain_dispatch',
                }
              : {}),
            trackRecord,
          },
        ];
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const request =
      input instanceof Request
        ? input
        : new Request(new URL(String(input), location.origin), init);
    const resource = new URL(request.url).pathname.split('/').at(-1);
    if (resource === 'source-environments')
      return Response.json({ available: true, items: [] });
    if (resource === 'context')
      return Response.json(contextFixture(organizationId, 'owner'));
    if (resource === 'autonomy' && request.method === 'GET')
      return Response.json({ available: true, policies: stored });
    if (resource === 'autonomy' && request.method === 'POST') {
      const body = await request.json();
      requests.push(body);
      const saved = {
        ...policy,
        ...body,
        tenantId: organizationId,
        revision: 1,
        mode: 'manual',
        trackRecord,
      };
      stored = [saved];
      if (requests.length === 1)
        throw new TypeError('Response lost after commit');

      return Response.json(saved);
    }
    if (['suppliers', 'purchase-orders', 'inventory'].includes(resource ?? ''))
      return Response.json({ items: [], nextCursor: null });

    return original(input, init);
  };

  return () => {
    globalThis.fetch = original;
  };
}

function Preview() {
  const [client] = useState(() => {
    const value = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    value.setQueryData(
      contextOptions(organizationId).queryKey,
      contextFixture(organizationId, 'owner'),
    );

    return value;
  });

  return (
    <QueryClientProvider client={client}>
      <style>{appStyles}</style>
      <main className="settings-content">
        <ScopedAutonomySettings organizationId={organizationId} />
      </main>
    </QueryClientProvider>
  );
}

const meta = {
  parameters: { layout: 'padded' },
  title: 'Settings/Delegated follow-ups',
  component: Preview,
  beforeEach: () => mock('ready'),
} satisfies Meta<typeof Preview>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Assisted: Story = {};

export const CircuitPaused: Story = { beforeEach: () => mock('paused') };

export const LostSaveResponse: Story = {
  beforeEach: () => mock('lost'),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      await canvas.findByRole('button', { name: m.settings_autonomy_create() }),
    );
    const page = within(canvasElement.ownerDocument.body);
    await userEvent.type(
      page.getByLabelText(m.settings_autonomy_name()),
      'Supplier notes',
    );
    await userEvent.type(
      page.getByLabelText(m.settings_autonomy_reason()),
      'Reviewed internal note limits',
    );
    await userEvent.click(page.getByRole('button', { name: m.common_save() }));
    await expect(
      page.findByText(m.settings_autonomy_change_unconfirmed()),
    ).resolves.toBeVisible();
    await userEvent.click(page.getByRole('button', { name: m.common_save() }));
    await waitFor(() => expect(requests).toHaveLength(2));
    await expect(requests[1]).toEqual(requests[0]);
    await expect(canvas.findByText('Supplier notes')).resolves.toBeVisible();
  },
};
