import type {
  WorkflowDetail,
  WorkflowReadiness,
  WorkflowSummary,
} from '@luma/api-contract';
import type { Meta, StoryObj } from '@storybook/react-vite';
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { useState } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';

import { StoryShell } from '../identity/storybook-shell';
import { WorkflowDetailView } from './detail';
import { type WorkflowFilters, WorkflowLibraryView } from './library';

const organizationId = '22222222-2222-4222-8222-222222222222';
const connectionId = '33333333-3333-4333-8333-333333333333';
const approval: WorkflowReadiness['approval'] = {
  mode: 'every_action',
  summary:
    'A different owner or admin approves every shipping-method correction before Luma acts.',
  details: [
    'This action is medium risk or higher, so workspace policy always requires approval.',
    'The person who started a run can’t approve it. Approval doesn’t extend expired evidence.',
  ],
};
const readiness = (
  overrides: Partial<WorkflowReadiness> = {},
): WorkflowReadiness => ({
  enablement: 'not_enabled',
  state: 'ready',
  issues: [],
  coverage: {
    unit: 'order',
    covered: 0,
    ready: 0,
    explanation:
      'No order is granted yet. An activation names the exact orders Luma may correct.',
  },
  approval,
  waiting: {
    count: 0,
    repair: { label: 'Open Needs you', destination: 'needs_you' },
  },
  outcomes: {
    runs: 0,
    verified: 0,
    unresolved: 0,
    inProgress: 0,
    latest: null,
  },
  nextAction: {
    label: 'Review activation',
    description:
      'Nothing runs until an owner or admin reviews the exact scope and turns it on.',
    repair: { label: 'Review activation', destination: 'workflow_rules' },
  },
  ...overrides,
});
const accessLost = readiness({
  enablement: 'enabled',
  state: 'blocked',
  issues: [
    {
      code: 'connection_access',
      severity: 'blocking',
      message:
        'Grant orders.shipping-method.write in Connections and validate access.',
      scope: 'JTL warehouse',
      repair: {
        label: 'Repair access in Connections',
        destination: 'connections',
        recordId: connectionId,
      },
    },
  ],
  coverage: {
    unit: 'order',
    covered: 2,
    ready: 0,
    explanation:
      '2 orders are granted. 0 can be corrected with current access.',
  },
  outcomes: {
    runs: 3,
    verified: 2,
    unresolved: 0,
    inProgress: 1,
    latest: {
      runId: '66666666-6666-4666-8666-666666666666',
      state: 'in_progress',
      at: '2026-10-03T07:40:00.000Z',
      summary: 'The correction is in progress.',
    },
  },
  nextAction: {
    label: 'Repair access in Connections',
    description:
      'JTL warehouse: Grant orders.shipping-method.write in Connections and validate access.',
    repair: {
      label: 'Repair access in Connections',
      destination: 'connections',
      recordId: connectionId,
    },
  },
});
const summary: WorkflowSummary = {
  id: 'shipping-method-correction',
  name: 'Correct an order shipping method',
  purpose:
    'Apply the mapped shipping method to an eligible order and verify the correction.',
  capability: 'orders.shipping-method.write',
  category: 'resolution',
  systems: ['jtl-cloud', 'jtl-onprem'],
  availableVersion: '0.1.0',
  activeVersions: [],
  status: 'inactive',
  blockers: [],
  readiness: readiness(),
};
const detail: WorkflowDetail = {
  summary,
  canManage: false,
  principalId: 'ada',
  policyVersion: 'v0.1',
  evaluationEvidence: 'unavailable',
  activations: [],
  connections: [],
  versions: [
    {
      version: '0.1.0',
      digest: 'a'.repeat(64),
      compatible: true,
      blockers: [],
      capability: summary.capability,
      capabilityVersion: '0',
      targetKind: 'order',
      category: 'resolution',
      format: 'resolution-playbook/0',
      applicability: {
        trigger: { kind: 'exception', issueType: 'workflow_failure' },
        subjectKind: 'order',
      },
      inputs: { shippingMethodId: 'number' },
      context: {
        kind: 'workflow_failure',
        fields: { diagnosisReady: 'boolean', methodMapped: 'boolean' },
        maxAgeSeconds: 300,
      },
      policy: { approval: 'required', minimumRisk: 'medium' },
      outcome: {
        kind: 'verified_postcondition',
        evaluatorVersion: 'shipping-method/1',
        onUnverified: 'escalate',
      },
      systems: summary.systems,
      approval: 'An independent administrator must approve each change.',
      permissions: ['orders.read', 'orders.shipping-method.write'],
      provenance: {
        kind: 'pilot',
        reference: 'Synthetic shipping-method correction',
        authoredBy: 'Luma',
        evidenceRefs: ['pilot-fixture'],
      },
      representation: '{"schemaVersion": 1}',
      steps: [
        {
          id: 'eligible',
          title: 'Check eligibility',
          description:
            'Diagnosis is ready and the shipping method has an approved mapping. Evidence must be less than five minutes old.',
          details: [],
        },
        {
          id: 'change',
          title: 'Propose the change',
          description:
            'Correct the shipping method on one explicitly granted order.',
          details: [
            'Expected result: the order uses the selected shipping method.',
          ],
        },
        {
          id: 'approval',
          title: 'Obtain approval',
          description:
            'An independent owner or administrator must approve each change.',
          details: [],
        },
        {
          id: 'verify',
          title: 'Verify the result',
          description:
            'Reread the authoritative order. Connector acceptance alone is not verified success.',
          details: [],
        },
        {
          id: 'recover',
          title: 'Recover or escalate',
          description:
            'Use reads to reconcile uncertain changes, then escalate if the result cannot be established.',
          details: [],
        },
      ],
    },
  ],
};

function Preview({
  state = 'ready',
}: {
  state?:
    | 'ready'
    | 'empty'
    | 'loading'
    | 'error'
    | 'member'
    | 'admin'
    | 'blocked'
    | 'unavailable'
    | 'revoked'
    | undefined;
}) {
  const [filters, setFilters] = useState<WorkflowFilters>({});

  return (
    <>
      <StoryShell page="Workflows">
        {['member', 'admin', 'blocked'].includes(state) ? (
          <div className="workflows-page">
            <WorkflowDetailView
              detail={
                state === 'member'
                  ? detail
                  : {
                      ...detail,
                      canManage: true,
                      summary:
                        state === 'blocked'
                          ? { ...summary, readiness: accessLost }
                          : summary,
                      connections: [
                        {
                          id: connectionId,
                          label: 'JTL warehouse',
                          system: 'jtl-cloud',
                          version: 1,
                          blockers:
                            state === 'blocked'
                              ? [
                                  'Validate connection permissions before activation.',
                                ]
                              : [],
                          targets: [
                            {
                              id: '44444444-4444-4444-8444-444444444444',
                              label: 'Order 1042',
                            },
                            {
                              id: '55555555-5555-4555-8555-555555555555',
                              label: 'Order 1043',
                            },
                          ],
                        },
                      ],
                    }
              }
              organizationId={organizationId}
              refresh={async () => {}}
              accessLost={async () => {}}
            />
          </div>
        ) : (
          <WorkflowLibraryView
            organizationId={organizationId}
            items={
              state === 'empty'
                ? []
                : state === 'loading' || state === 'error'
                  ? undefined
                  : [
                      {
                        ...summary,
                        status:
                          state === 'unavailable'
                            ? 'unavailable'
                            : state === 'revoked'
                              ? 'revoked'
                              : 'active',
                        readiness:
                          state === 'revoked'
                            ? readiness({
                                enablement: 'paused',
                                nextAction: {
                                  label: 'Review a new activation',
                                  description:
                                    'Every activation was revoked, so no new runs start. Earlier history stays available.',
                                  repair: {
                                    label: 'Review a new activation',
                                    destination: 'workflow_rules',
                                  },
                                },
                              })
                            : accessLost,
                      },
                      ...(state === 'ready'
                        ? [
                            {
                              ...summary,
                              id: 'inventory-replenishment',
                              name: 'Replenish low stock',
                              purpose:
                                'Check low stock, review existing commitments, and create a verified purchase-order draft.',
                              systems: ['luma'],
                              category: 'procurement',
                              status: 'active' as const,
                              activeVersions: ['1.0.0'],
                              readiness: readiness({
                                enablement: 'enabled',
                                state: 'degraded',
                                issues: [
                                  {
                                    code: 'stock_expired',
                                    severity: 'degrading',
                                    message:
                                      'The latest stock read is older than five minutes, so Luma won’t propose an order. Check that the source is syncing.',
                                    scope: 'SKU-BLUE-M',
                                    repair: {
                                      label: 'Review stock for SKU-BLUE-M',
                                      destination: 'inventory_position',
                                      recordId:
                                        '77777777-7777-4777-8777-777777777777',
                                    },
                                  },
                                ],
                                coverage: {
                                  unit: 'stock position',
                                  covered: 3,
                                  ready: 2,
                                  explanation:
                                    '3 stock positions have an active rule. 2 with fresh stock.',
                                },
                                waiting: {
                                  count: 1,
                                  repair: {
                                    label: 'Review the waiting decision',
                                    destination: 'needs_you',
                                    recordId:
                                      'replenishment:88888888-8888-4888-8888-888888888888',
                                  },
                                },
                                nextAction: {
                                  label: 'Review 1 waiting decision',
                                  description:
                                    'Proposals wait for a person before Luma acts. They expire when their evidence gets old.',
                                  repair: {
                                    label: 'Review the waiting decision',
                                    destination: 'needs_you',
                                    recordId:
                                      'replenishment:88888888-8888-4888-8888-888888888888',
                                  },
                                },
                              }),
                            },
                            {
                              ...summary,
                              id: 'address-correction',
                              name: 'Correct a delivery address',
                              purpose:
                                'Review an address correction before updating the warehouse order.',
                              systems: ['jtl-onprem'],
                              status: 'inactive' as const,
                              readiness: readiness(),
                            },
                            {
                              ...summary,
                              id: 'quantity-calculation',
                              name: 'Calculate replenishment quantity',
                              purpose:
                                'Calculate the quantity needed to restore stock.',
                              systems: [],
                              category: 'procurement',
                              status: 'unavailable' as const,
                              readiness: readiness({
                                state: 'blocked',
                                coverage: {
                                  unit: 'run',
                                  covered: null,
                                  ready: null,
                                  explanation:
                                    'This workflow has no scoped records. It runs on the evidence supplied when someone starts it.',
                                },
                                waiting: { count: null, repair: null },
                                issues: [
                                  {
                                    code: 'no_adapter',
                                    severity: 'blocking',
                                    message:
                                      'No installed adapter runs this workflow. Custom workflows run when they contain a Code Step and only computation steps.',
                                    scope: null,
                                    repair: null,
                                  },
                                ],
                                nextAction: {
                                  label: 'Review the requirement',
                                  description:
                                    'No installed adapter runs this workflow. Custom workflows run when they contain a Code Step and only computation steps.',
                                  repair: null,
                                },
                              }),
                            },
                          ]
                        : []),
                    ]
            }
            filters={filters}
            change={setFilters}
            loading={state === 'loading'}
            error={
              state === 'error'
                ? 'Workflows are unavailable. Check your connection and retry.'
                : undefined
            }
            refresh={() => {}}
          />
        )}
      </StoryShell>
    </>
  );
}

function RoutedPreview({
  state,
}: {
  state: Parameters<typeof Preview>[0]['state'];
}) {
  const [router] = useState(() =>
    createRouter({
      history: createMemoryHistory(),
      routeTree: createRootRoute({
        component: () => <Preview state={state} />,
      }),
    }),
  );

  return <RouterProvider router={router} />;
}

const meta = {
  title: 'Workflows/Library',
  component: Preview,
  parameters: { layout: 'fullscreen' },
  render: (args) => <RoutedPreview state={args.state} />,
} satisfies Meta<typeof Preview>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Library: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole('link', { name: summary.name }),
    ).toBeVisible();
    await userEvent.type(
      canvas.getByLabelText('Search workflows'),
      'not found',
    );
    await expect(
      canvas.getByRole('heading', { name: 'No matching workflows' }),
    ).toBeVisible();
    await userEvent.click(
      canvas.getByRole('button', { name: 'Clear filters' }),
    );
    await expect(
      canvas.getByRole('link', { name: summary.name }),
    ).toBeVisible();
  },
};

export const Empty: Story = { args: { state: 'empty' } };

export const Loading: Story = { args: { state: 'loading' } };

export const Unavailable: Story = { args: { state: 'error' } };

export const MissingPrerequisites: Story = { args: { state: 'unavailable' } };

export const Revoked: Story = { args: { state: 'revoked' } };

export const MemberDetail: Story = {
  args: { state: 'member' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole('button', {
        name: 'Review activation',
      }),
    ).toBeDisabled();
    await expect(
      canvas.getByRole('heading', { name: 'Verify the result' }),
    ).toBeVisible();
    await expect(
      canvas.getByRole('heading', { name: 'Ready to set up' }),
    ).toBeVisible();
  },
};

export const Narrow: Story = {
  globals: { viewport: { value: 'mobile1', isRotated: false } },
};

export const Dark: Story = { globals: { theme: 'dark' } };

export const AdminDetail: Story = {
  args: { state: 'admin' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const body = within(canvasElement.ownerDocument.body);
    await userEvent.click(
      canvas.getByRole('button', { name: 'Review activation' }),
    );
    const dialog = within(await body.findByRole('dialog'));
    await expect(
      dialog.getByRole('button', { name: 'Activate reviewed version' }),
    ).toBeDisabled();
    await userEvent.click(dialog.getByRole('combobox', { name: 'Connection' }));
    await userEvent.click(
      await body.findByRole('option', { name: 'JTL warehouse' }),
    );
    await userEvent.click(dialog.getByRole('checkbox', { name: /Order 1042/ }));
    await userEvent.click(
      dialog.getByRole('checkbox', {
        name: 'I reviewed this version, order scope and approval requirements.',
      }),
    );
    await expect(
      dialog.getByRole('button', { name: 'Activate reviewed version' }),
    ).toBeEnabled();
    await userEvent.click(dialog.getByRole('checkbox', { name: /Order 1043/ }));
    await expect(
      dialog.getByRole('button', { name: 'Activate reviewed version' }),
    ).toBeDisabled();
    await userEvent.click(dialog.getByRole('button', { name: 'Cancel' }));
    await waitFor(() =>
      expect(body.queryByRole('dialog')).not.toBeInTheDocument(),
    );
  },
};

/** An enabled workflow whose connection lost access shows Blocked and links to the repair. */
export const BlockedDetail: Story = {
  args: { state: 'blocked' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole('heading', { name: 'Can’t run right now' }),
    ).toBeVisible();
    await expect(canvas.getAllByText('Enabled')[0]).toBeVisible();
    await expect(
      canvas.getByRole('link', { name: 'Repair access in Connections' }),
    ).toHaveAttribute(
      'href',
      expect.stringContaining(`#connection-${connectionId}`),
    );
    await expect(canvas.getByText('0 of 2 orders ready')).toBeVisible();
  },
};

export const Filters: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const body = within(canvasElement.ownerDocument.body);
    await userEvent.click(
      canvas.getByRole('button', { name: 'Needs attention 3' }),
    );
    await expect(
      canvas.getByRole('link', { name: 'Replenish low stock' }),
    ).toBeVisible();
    await expect(
      canvas.queryByRole('link', { name: 'Correct a delivery address' }),
    ).not.toBeInTheDocument();
    await userEvent.click(canvas.getByRole('button', { name: 'Enabled 2' }));
    await expect(
      canvas.getByRole('link', { name: summary.name }),
    ).toBeVisible();
    await expect(
      canvas.getByRole('link', { name: 'Review 1 waiting decision' }),
    ).toBeVisible();
    await userEvent.click(canvas.getByRole('combobox', { name: 'System' }));
    await userEvent.click(await body.findByRole('option', { name: 'Luma' }));
    await expect(
      canvas.queryByRole('link', { name: summary.name }),
    ).not.toBeInTheDocument();
    await userEvent.type(canvas.getByLabelText('Search workflows'), 'address');
    await expect(
      canvas.getByRole('heading', { name: 'No matching workflows' }),
    ).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Clear search' }));
    await userEvent.click(
      canvas.getByRole('button', { name: 'Remove Luma filter' }),
    );
    await expect(
      canvas.getByRole('link', { name: summary.name }),
    ).toBeVisible();
    await userEvent.click(
      canvas.getByRole('button', { name: 'Clear filters' }),
    );
    await userEvent.type(
      canvas.getByLabelText('Search workflows'),
      'commitments',
    );
    await expect(
      canvas.getByRole('link', { name: 'Replenish low stock' }),
    ).toBeVisible();
    await expect(
      canvas.queryByRole('link', { name: summary.name }),
    ).not.toBeInTheDocument();
  },
};

export const DetailNavigation: Story = {
  args: { state: 'admin' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      canvas.getByRole('button', { name: 'Technical details' }),
    );
    await expect(
      canvas.getByRole('region', { name: 'Technical details' }),
    ).toHaveFocus();
    await expect(
      canvas.getByRole('button', { name: 'Technical details' }),
    ).toHaveAttribute('aria-current', 'location');
    await userEvent.click(canvas.getByRole('button', { name: 'Overview' }));
  },
};
