import type { OrderChangePlan, OrderChangePlans } from '@luma/api-contract';
import { Button } from '@luma/ui/components/primitives/button';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, userEvent, within } from 'storybook/test';

import appStyles from '../../styles.css?inline';
import { OrderChangePlanView } from './change-plan';

const shop = '44444444-4444-4444-8444-444444444444';
const erp = '55555555-5555-4555-8555-555555555555';
const record = '77777777-7777-4777-8777-777777777777';
const sku = '99999999-9999-4999-8999-999999999999';
const read = '2026-10-12T09:58:00.000Z';
const sources = [
  { connectionId: shop, label: 'Tokyo store' },
  { connectionId: erp, label: 'JTL-Wawi' },
  { connectionId: record, label: 'Luma ERP' },
];
const lines = [
  { key: sku, label: 'Canvas tote · TOTE-NAT', quantity: '3', unit: 'each' },
];

type Step = OrderChangePlan['steps'][number];

const step = (overrides: Partial<Step>): Step => ({
  id: 'step',
  kind: 'update_record',
  action: 'update_quantity',
  performer: 'person',
  role: 'operator',
  connectionId: erp,
  capability: null,
  executable: false,
  blockedBy: null,
  permission: null,
  viewerCanRequest: false,
  handoff: null,
  ...overrides,
});

const luma = (overrides: Partial<Step> = {}): Step =>
  step({
    id: 'luma',
    performer: 'luma',
    role: null,
    connectionId: shop,
    capability: 'orders.quantity.edit',
    executable: true,
    permission: 'shopify:order_edits.apply',
    viewerCanRequest: true,
    handoff: {
      orderExternalId: 'gid://shopify/Order/1001',
      lines: [{ externalId: 'gid://shopify/LineItem/11', quantity: '1' }],
    },
    ...overrides,
  });

const plan = (overrides: Partial<OrderChangePlan> = {}): OrderChangePlan => ({
  change: {
    kind: 'quantity',
    origin: 'proposed',
    lineKey: sku,
    line: { skuCode: 'TOTE-NAT', title: 'Canvas tote' },
    from: '3',
    to: '1',
    unit: 'each',
  },
  acknowledgements: [
    {
      connectionId: shop,
      state: 'differs',
      value: '3',
      readAt: read,
      fresh: true,
    },
    {
      connectionId: erp,
      state: 'unknown',
      value: null,
      readAt: read,
      fresh: true,
    },
  ],
  shipped: [
    {
      lineKey: sku,
      units: '0',
      unit: 'each',
      basis: 'authority',
      connectionId: erp,
      sources: [
        { connectionId: shop, units: '0' },
        { connectionId: erp, units: '0' },
      ],
    },
  ],
  safety: { state: 'safe', reasons: [] },
  steps: [luma(), step({ id: 'erp' })],
  ...overrides,
});

const escalate = (state: 'unsafe' | 'unknown') =>
  step({
    id: 'escalate',
    kind: 'escalate',
    action: state === 'unsafe' ? 'escalate_unsafe' : 'escalate_unknown',
    connectionId: null,
  });

const scenarios = {
  executable: [plan()],
  picking: [
    plan({
      safety: {
        state: 'unsafe',
        reasons: [{ code: 'work_started', connectionId: erp, lineKey: sku }],
      },
      steps: [
        step({
          id: 'confirm',
          kind: 'confirm',
          action: 'confirm_picking',
          role: 'warehouse',
        }),
        luma({ executable: false, blockedBy: 'unsafe' }),
        step({ id: 'erp' }),
        escalate('unsafe'),
      ],
    }),
  ],
  stale: [
    plan({
      acknowledgements: [
        {
          connectionId: shop,
          state: 'differs',
          value: '3',
          readAt: read,
          fresh: true,
        },
        {
          connectionId: erp,
          state: 'unknown',
          value: null,
          readAt: '2026-10-12T09:40:00.000Z',
          fresh: false,
        },
      ],
      safety: {
        state: 'unknown',
        reasons: [{ code: 'stale_evidence', connectionId: erp, lineKey: null }],
      },
      steps: [
        step({
          id: 'check',
          kind: 'confirm',
          action: 'check_progress',
          role: 'warehouse',
        }),
        luma({ executable: false, blockedBy: 'unknown' }),
        step({ id: 'erp' }),
        escalate('unknown'),
      ],
    }),
  ],
  restricted: [
    plan({
      shipped: [],
      safety: {
        state: 'unknown',
        reasons: [
          { code: 'fulfilment_hidden', connectionId: null, lineKey: null },
        ],
      },
      steps: [
        step({
          id: 'check',
          kind: 'confirm',
          action: 'check_progress',
          role: 'warehouse',
        }),
        luma({
          executable: false,
          blockedBy: 'unknown',
          viewerCanRequest: false,
        }),
        step({ id: 'erp' }),
        escalate('unknown'),
      ],
    }),
  ],
  observe: [
    plan({
      steps: [
        luma({ executable: false, blockedBy: 'observe_only' }),
        step({ id: 'erp' }),
      ],
    }),
  ],
  permission: [plan({ steps: [luma({ viewerCanRequest: false }), step({})] })],
  detected: [] as OrderChangePlan[],
  // Luma's own record holds line authority; the shop lags and JTL reports no current units.
  propagation: [
    plan({
      change: { ...plan().change, origin: 'detected', from: '3', to: '2' },
      acknowledgements: [
        {
          connectionId: record,
          state: 'reflects',
          value: '2',
          readAt: read,
          fresh: true,
        },
        ...plan().acknowledgements,
      ],
    }),
  ],
} satisfies Record<string, OrderChangePlan[]>;

type Scenario = keyof typeof scenarios;

function Preview({ scenario }: { scenario: Scenario }) {
  const [opened, setOpened] = useState<string | null>(null);
  const [proposal, setProposal] = useState<{
    lineKey: string;
    quantity: string;
  } | null>(scenario === 'detected' ? null : { lineKey: sku, quantity: '1' });
  const plans: OrderChangePlans = {
    orderId: '66666666-6666-4666-8666-000000000001',
    comparisonState: 'matching',
    plans: scenarios[scenario],
    hidden: scenario === 'restricted' ? ['fulfillments'] : [],
    asOf: '2026-10-12T10:00:00.000Z',
  };

  return (
    <div style={{ maxWidth: 880, padding: 16 }}>
      <style>{appStyles}</style>
      <OrderChangePlanView
        plans={plans}
        sources={sources}
        authority={scenario === 'propagation' ? record : erp}
        lines={lines}
        proposal={proposal ? { kind: 'quantity', ...proposal } : null}
        propose={(lineKey, quantity) => setProposal({ lineKey, quantity })}
        clear={() => setProposal(null)}
        editAction={(item) => (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setOpened(item.connectionId)}
          >
            Review in Tokyo store
          </Button>
        )}
      />
      {opened ? <p role="status">Opened the edit for {opened}</p> : null}
    </div>
  );
}

const meta = {
  title: 'Orders/Change plan',
  component: Preview,
  args: { scenario: 'executable' },
} satisfies Meta<typeof Preview>;

export default meta;

type Story = StoryObj<typeof meta>;

export const ExecutableBeforePicking: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('Safe to change')).toBeVisible();
    await expect(canvas.getByText('From 3 to 1')).toBeVisible();
    await expect(
      canvas.getByText('Luma can run this after a preview and approval.'),
    ).toBeVisible();
    await expect(canvas.getByText('Person: Operations')).toBeVisible();
    await userEvent.click(
      canvas.getByRole('button', { name: 'Review in Tokyo store' }),
    );
    await expect(canvas.getByRole('status')).toHaveTextContent(shop);
  },
};

export const PersonStepAfterPicking: Story = {
  args: { scenario: 'picking' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('Not safe to change')).toBeVisible();
    await expect(
      canvas.getByText('Fulfillment has started on this order.'),
    ).toBeVisible();
    await expect(canvas.getByText('Person: Warehouse')).toBeVisible();
    await expect(
      canvas.getByText('Waits until the steps above make the change safe.'),
    ).toBeVisible();
    await expect(
      canvas.queryByRole('button', { name: 'Review in Tokyo store' }),
    ).toBeNull();
  },
};

export const UnknownStale: Story = {
  args: { scenario: 'stale' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('Safety unknown')).toBeVisible();
    await expect(
      canvas.getByText('Read more than five minutes ago'),
    ).toBeVisible();
  },
};

export const Restricted: Story = {
  args: { scenario: 'restricted' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByText(
        'You don’t have access to fulfillment, so Luma can’t tell you whether a change is still safe.',
      ),
    ).toBeVisible();
    await expect(canvas.getByText('Safety unknown')).toBeVisible();
  },
};

export const ObserveOnly: Story = {
  args: { scenario: 'observe' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByText(
        'Not possible now: Luma only observes. Writes are turned off.',
      ),
    ).toBeVisible();
  },
};

export const NeedsPermission: Story = {
  args: { scenario: 'permission' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByText(/Requesting it needs the permission/),
    ).toBeVisible();
  },
};

/** Proposes a quantity with the keyboard only. */
export const ProposeWithKeyboard: Story = {
  args: { scenario: 'detected' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByText(
        'The sources show no change to plan. Propose a quantity to see what it would take.',
      ),
    ).toBeVisible();
    const quantity = canvas.getByLabelText('New quantity');
    await userEvent.click(quantity);
    await userEvent.keyboard('-1{Enter}');
    await expect(canvas.getByRole('alert')).toHaveTextContent(
      'Enter a quantity of zero or more',
    );
    await userEvent.clear(quantity);
    await userEvent.keyboard('2');
    await userEvent.tab();
    await expect(
      canvas.getByRole('button', { name: 'Plan this change' }),
    ).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await expect(
      await canvas.findByRole('button', { name: 'Show detected changes' }),
    ).toBeVisible();
  },
};

export const DetectedPropagation: Story = {
  args: { scenario: 'propagation' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByText(
        'Luma ERP sets this quantity to 2; Tokyo store still shows 3; JTL-Wawi doesn’t report it.',
      ),
    ).toBeVisible();
  },
};

export const AfterPickingDark: Story = {
  args: { scenario: 'picking' },
  globals: { theme: 'dark' },
};

export const AfterPickingNarrow: Story = {
  args: { scenario: 'picking' },
  globals: { viewport: { value: 'mobile1', isRotated: false } },
};
