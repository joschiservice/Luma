import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';

import { ActionDiff } from './action-diff';

const meta = {
  title: 'Cases/Action diff',
  component: ActionDiff,
  args: {
    diff: {
      schemaVersion: 1,
      capability: 'inventory.available.reconcile',
      records: [
        {
          system: 'provider',
          connectionId: '00000000-0000-4000-8000-000000000001',
          kind: 'inventory_item',
          id: 'item-12',
          changes: [
            {
              field: 'available',
              before: 15,
              beforeKnown: true,
              after: 12,
              afterKnown: true,
              expected: 15,
              expectedKnown: true,
            },
          ],
        },
      ],
      scope: [
        { kind: 'inventory_item', count: 1, ids: ['item-12'] },
        { kind: 'location', count: 1, ids: ['warehouse'] },
      ],
      reversibility: 'compensatable',
      evidence: {
        refs: ['stock-observation'],
        observedAt: '2026-10-13T11:55:00Z',
        validUntil: '2026-10-13T12:00:00Z',
      },
      retryProtection: 'immutable_intent_reconcile_before_retry',
      canonicalOutcome: 'requires_fresh_verification',
    },
  },
  decorators: [
    (Story) => (
      <div style={{ maxWidth: 600, padding: 16 }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ActionDiff>;

export default meta;

type Story = StoryObj<typeof meta>;

export const StockCorrection: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await expect(
      c.getByRole('columnheader', { name: 'Expected before dispatch' }),
    ).toBeVisible();
    await userEvent.click(c.getByText('1 evidence reference'));
    await expect(c.getByText('stock-observation')).toBeVisible();
  },
};

export const UnknownBaseline: Story = {
  args: {
    diff: {
      ...meta.args.diff,
      capability: 'orders.write',
      reversibility: 'irreversible',
      records: [
        {
          ...meta.args.diff.records[0]!,
          kind: 'order',
          changes: [
            {
              field: 'status',
              before: null,
              beforeKnown: false,
              after: 'cancelled',
              afterKnown: true,
              expected: null,
              expectedKnown: false,
            },
          ],
        },
      ],
      evidence: { ...meta.args.diff.evidence, observedAt: null },
    },
  },
};

export const Narrow: Story = {
  decorators: [
    (Story) => (
      <div style={{ width: 280 }}>
        <Story />
      </div>
    ),
  ],
};
