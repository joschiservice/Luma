import type { AutoLinkRule } from '@luma/api-contract';
import type { Meta, StoryObj } from '@storybook/react-vite';

import appStyles from '../../styles.css?inline';
import { AutomaticLinksView } from './automatic-links';
import { jtl, shopify } from './sync-fixtures';

const rule: AutoLinkRule = {
  id: '11111111-1111-4111-8111-111111111111',
  kind: 'sku',
  revision: 1,
  targetConnectionId: shopify.connectionId,
  sourceConnectionId: jtl.connectionId,
  enabled: true,
  principalId: 'operator',
  state: 'active',
  message: null,
  lastCheckedAt: '2026-09-15T10:00:00.000Z',
  linked: 124,
};

const meta = {
  title: 'Workspaces/Data sync/Automatic linking',
  component: AutomaticLinksView,
  decorators: [
    (Story) => (
      <>
        <style>{appStyles}</style>
        <Story />
      </>
    ),
  ],
  args: {
    connections: [shopify, jtl],
    rules: [rule],
    canManage: true,
    loading: false,
    error: null,
    add: () => undefined,
    edit: () => undefined,
    disable: () => undefined,
    retry: () => undefined,
  },
} satisfies Meta<typeof AutomaticLinksView>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Enabled: Story = {};

export const Waiting: Story = {
  args: {
    rules: [
      {
        ...rule,
        state: 'waiting',
        linked: 0,
        message:
          'Waiting for both connections to complete successful full reads.',
      },
    ],
  },
};

export const NeedsAccess: Story = {
  args: {
    rules: [
      {
        ...rule,
        state: 'blocked',
        message:
          'The person this rule runs as no longer manages imports. Preview and enable it again with your access.',
      },
    ],
  },
};

export const Disabled: Story = {
  args: { rules: [{ ...rule, state: 'disabled', enabled: false }] },
};

export const ReadOnly: Story = { args: { canManage: false } };

export const Empty: Story = { args: { rules: [] } };

export const Failed: Story = {
  args: {
    error: 'Automatic linking rules could not be loaded.',
    rules: undefined,
  },
};
