import './settings.css';

import type { AuthoritySnapshot } from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';

import appStyles from '../../styles.css?inline';
import { SourceAuthorityView } from './source-authority';

const shop = '11111111-1111-4111-8111-111111111111';
const erp = '22222222-2222-4222-8222-222222222222';
const data: AuthoritySnapshot = {
  revision: 0,
  connections: [
    {
      id: shop,
      label: 'Tokyo store',
      category: 'storefront',
      available: true,
      capabilities: ['orders.read', 'fulfillment.read', 'inventory.read'],
    },
    {
      id: erp,
      label: 'JTL-Wawi',
      category: 'erp',
      available: true,
      capabilities: ['orders.read', 'fulfillment.read', 'inventory.read'],
    },
  ],
  groups: (
    [
      'order_lines',
      'order_lifecycle',
      'order_fulfillment',
      'order_tracking',
      'inventory_stock',
      'inventory_selling',
    ] as const
  ).map((group) => {
    const connectionId = [
      'order_lines',
      'order_lifecycle',
      'inventory_selling',
    ].includes(group)
      ? shop
      : erp;

    return {
      group,
      state: 'resolved',
      basis: 'default',
      connectionId,
      overrideConnectionId: null,
      candidateIds: [connectionId],
      eligibleIds: group === 'inventory_selling' ? [shop] : [shop, erp],
    };
  }),
};

const meta = {
  title: 'Features/Settings/Source authority',
  component: SourceAuthorityView,
  parameters: { layout: 'fullscreen' },
  decorators: [
    (Story) => (
      <>
        <style>{appStyles}</style>
        <div className="settings-page">
          <div className="settings-content">
            <Story />
          </div>
        </div>
      </>
    ),
  ],
  args: { data, disabled: false, save: () => undefined },
} satisfies Meta<typeof SourceAuthorityView>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Defaults: Story = {};

export const Dark: Story = { globals: { theme: 'dark' } };

export const ReadOnly: Story = { args: { disabled: true } };

export const Conflicting: Story = {
  args: {
    data: {
      ...data,
      groups: data.groups.map((group) =>
        group.group === 'order_lines'
          ? { ...group, state: 'conflicting', connectionId: null }
          : group,
      ),
    },
  },
};

export const UnavailableOverride: Story = {
  args: {
    data: {
      ...data,
      connections: data.connections.map((connection) =>
        connection.id === erp
          ? { ...connection, available: false }
          : connection,
      ),
      groups: data.groups.map((group) =>
        group.group === 'order_fulfillment'
          ? {
              ...group,
              state: 'unknown',
              basis: 'override',
              connectionId: null,
              overrideConnectionId: erp,
            }
          : group,
      ),
    },
  },
};

function Editable() {
  const [state, setState] = useState(data);

  return (
    <SourceAuthorityView
      data={state}
      disabled={false}
      save={(group, connectionId) =>
        setState((previous) => ({
          ...previous,
          revision: previous.revision + 1,
          groups: previous.groups.map((fact) =>
            fact.group === group
              ? {
                  ...fact,
                  basis: connectionId ? 'override' : 'default',
                  connectionId:
                    connectionId ??
                    data.groups.find((item) => item.group === group)!
                      .connectionId,
                  overrideConnectionId: connectionId,
                }
              : fact,
          ),
        }))
      }
    />
  );
}

export const EditOverride: Story = {
  render: () => <Editable />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const input = canvas.getByRole('combobox', {
      name: m.orders_authority_lines(),
    });
    await userEvent.click(input);
    const option = await within(canvasElement.ownerDocument.body).findByRole(
      'option',
      { name: 'JTL-Wawi' },
    );
    await waitFor(() => userEvent.click(option));
    const row = input.closest('tr')!;
    await userEvent.click(
      within(row).getByRole('button', { name: m.common_save() }),
    );
    await expect(
      canvas.getByText(m.orders_authority_override({ source: 'JTL-Wawi' })),
    ).toBeVisible();
  },
};
