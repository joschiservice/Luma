import type { AppUiProps } from '@luma/app-host/web';
import { PageHeader } from '@luma/ui/components/workspace/page-header';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { type ComponentType, useMemo, useState } from 'react';
import { expect, userEvent, within } from 'storybook/test';

import appStyles from '../../styles.css?inline';

const modules = import.meta.glob<{
  ShopifyInventoryCorrection: ComponentType<{
    positionId: string;
    services: AppUiProps['services'];
  }>;
}>('../../../../../packages/apps/*/src/web/inventory-correction.tsx');
const load = Object.values(modules)[0];
// Import the app while the story file loads: its first Vite compile can outlast a story's
// test time limit in parallel runs, and story loaders count toward that limit.
const Correction = load ? (await load()).ShopifyInventoryCorrection : null;
const positionId = '11111111-1111-4111-8111-111111111111',
  connectionId = '22222222-2222-4222-8222-222222222222',
  sourceConnectionId = '33333333-3333-4333-8333-333333333333';

type Scenario =
  | 'review'
  | 'approval'
  | 'accepted'
  | 'uncertain'
  | 'verified'
  | 'missing_access'
  | 'stale'
  | 'ambiguous';

function Preview({
  scenario = 'review',
  native = false,
}: {
  scenario?: Scenario;
  native?: boolean;
}) {
  const [storyTime] = useState(() => Date.now());
  const services = useMemo<AppUiProps['services']>(() => {
    const time = new Date(storyTime).toISOString();
    const before = {
      id: '44444444-4444-4444-8444-444444444444',
      observedAt: time,
      revision: 'before',
      targetRevision: 'target',
      inventoryItemId: 'gid://shopify/InventoryItem/2001',
      locationId: 'gid://shopify/Location/81',
      locationName: 'Tokyo warehouse',
      available: 24,
      tracked: true,
      itemActive: !native,
      locationActive: true,
      complete: true,
      source: {
        connectionId: native ? connectionId : sourceConnectionId,
        ...(native
          ? {
              nativeAllocation: {
                scope: {
                  connectionId,
                  locationId: positionId,
                  version: '3',
                  mode: 'own',
                  authorityRevision: 1,
                  lastTransitionId: positionId,
                  updatedAt: time,
                },
                authorityRevision: 1,
                skuId: positionId,
                locationId: positionId,
                unit: 'each',
                available: '18',
                accounts: [
                  {
                    id: positionId,
                    address: {
                      skuId: positionId,
                      locationId: positionId,
                      unit: 'each',
                      state: 'available',
                    },
                    balance: '18',
                    version: '1',
                  },
                ],
                openingReviewIds: [positionId],
              },
            }
          : {}),
        label: native ? 'Luma native stock' : 'JTL-Wawi',
        observationId: '55555555-5555-4555-8555-555555555555',
        observedAt:
          scenario === 'stale'
            ? new Date(storyTime - 360_000).toISOString()
            : time,
        revision: 'erp',
        available: 18,
      },
    };
    const review = {
      id: '66666666-6666-4666-8666-666666666666',
      target: { positionId, connectionId, sourceConnectionId },
      choice: { capability: 'inventory.available.reconcile' },
      before,
      requesterId: 'requester',
      expiresAt: new Date(storyTime + 300_000).toISOString(),
      decisionId: '77777777-7777-4777-8777-777777777777',
      state: 'approval_required',
      acceptance: 'not_sent',
      message:
        'Someone else who can approve changes must approve this exact action.',
      canExecute: false,
      canApprove: scenario === 'approval',
    };
    const saved =
      scenario === 'uncertain'
        ? {
            ...review,
            state: 'uncertain',
            acceptance: 'unknown',
            canApprove: false,
            message:
              'The write outcome is uncertain. Check Shopify before another correction. This action will not be resent.',
          }
        : scenario === 'verified'
          ? {
              ...review,
              state: 'verified',
              acceptance: 'accepted',
              canApprove: false,
              message:
                'A fresh Shopify read matches the approved ERP quantity.',
            }
          : scenario === 'accepted'
            ? {
                ...review,
                state: 'recovery_required',
                acceptance: 'accepted',
                canApprove: false,
                message:
                  'Shopify accepted the correction. The quantity is not yet verified.',
              }
            : review;

    return {
      install: async () => {
        throw new Error('Unavailable in this preview');
      },
      rotate: async () => {
        throw new Error('Unavailable in this preview');
      },
      error: (error) =>
        error instanceof Error ? error.message : 'Refresh and try again.',
      uncertain: () => false,
      async request(path) {
        if (path.endsWith('candidates'))
          return [
            {
              connectionId,
              label: 'Shopify · Japan',
              provider: 'shopify',
              available: '24',
              observedAt: time,
            },
            {
              connectionId: native ? connectionId : sourceConnectionId,
              label: native ? 'Luma native stock' : 'JTL-Wawi',
              provider: native ? 'native_stock' : 'jtl',
              available: '18',
              observedAt: time,
            },
          ];
        if (path.endsWith('inspect')) {
          if (scenario === 'ambiguous')
            throw new Error(
              'SKU or location mappings are ambiguous. Confirm one exact source mapping before correcting stock.',
            );

          return {
            snapshot: before,
            granted:
              scenario === 'missing_access'
                ? []
                : ['inventory.available.reconcile'],
            runs: ['approval', 'accepted', 'uncertain', 'verified'].includes(
              scenario,
            )
              ? [saved]
              : [],
          };
        }
        if (path.endsWith('preview')) return review;
        if (path.endsWith('approve'))
          return {
            ...review,
            canApprove: false,
            message: 'Approved. The requester can apply the correction.',
          };
        if (path.endsWith('check'))
          return {
            ...review,
            canApprove: false,
            canExecute: true,
            message: 'Approved. Ready to apply to Shopify.',
          };

        return {
          ...review,
          state: 'verified',
          acceptance: 'accepted',
          canApprove: false,
          canExecute: false,
          message: 'A fresh Shopify read matches the approved ERP quantity.',
        };
      },
    };
  }, [scenario, storyTime, native]);

  return (
    <main className="inventory-page">
      <style>{appStyles}</style>
      <PageHeader title="LINEN-SHIRT-M" description="Tokyo warehouse · units" />
      {Correction ? (
        <Correction positionId={positionId} services={services} />
      ) : null}
    </main>
  );
}

const meta = {
  title: 'Inventory/Shopify stock correction',
  component: Preview,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof Preview>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Review: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.findByText('24 → 18 available')).resolves.toBeVisible();
    await userEvent.click(
      await canvas.findByRole('button', {
        name: 'Review correction',
      }),
    );
    await expect(
      canvas.findByText(
        'Someone else who can approve changes must approve this exact action.',
      ),
    ).resolves.toBeVisible();
    expect(
      canvas.queryByRole('button', { name: 'Send to Shopify' }),
    ).toBeNull();
  },
};

export const NeedsApproval: Story = { args: { scenario: 'approval' } };

export const Accepted: Story = { args: { scenario: 'accepted' } };

export const Uncertain: Story = { args: { scenario: 'uncertain' } };

export const Verified: Story = { args: { scenario: 'verified' } };

export const MissingWriteAccess: Story = {
  args: { scenario: 'missing_access' },
};

export const StaleEvidence: Story = { args: { scenario: 'stale' } };

export const AmbiguousMapping: Story = { args: { scenario: 'ambiguous' } };

export const NativeAllocation: Story = {
  args: { native: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole('heading', { name: 'Publish native allocation' }),
    ).toBeVisible();
    await expect(
      await canvas.findByText(/Inventory item: Inactive. Location: Active./),
    ).toBeVisible();
    await expect(
      canvas.getByRole('textbox', { name: 'Whole-unit allocation' }),
    ).toHaveValue('18');
  },
};

export const NativeAllocationDark: Story = {
  ...NativeAllocation,
  globals: { theme: 'dark' },
};
