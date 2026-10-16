import type {
  WorkflowDetail,
  WorkflowReadiness,
  WorkflowRunView,
  WorkflowSummary,
} from '@luma/api-contract';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { useState } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';

import { StoryShell } from '../../shell/storybook-shell';
import { WorkflowDetailView } from './detail';
import { type WorkflowFilters, WorkflowLibraryView } from './library';
import { WorkflowRuns } from './runs';

const organizationId = '22222222-2222-4222-8222-222222222222';
const connectionId = '33333333-3333-4333-8333-333333333333';
const approval: WorkflowReadiness['approval'] = {
  mode: 'every_action',
  summary:
    'Someone else who can approve changes approves every shipping-method correction before Luma acts.',
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
    recent: [],
  },
  nextAction: {
    label: 'Review activation',
    description:
      'Nothing runs until someone reviews the exact scope and turns it on.',
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
    recent: [
      { state: 'in_progress', at: '2026-10-03T07:40:00.000Z' },
      { state: 'verified', at: '2026-10-02T09:10:00.000Z' },
      { state: 'verified', at: '2026-10-01T15:25:00.000Z' },
    ],
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
  trigger: { kind: 'exception', issueType: 'shipping_method_mismatch' },
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
  people: [],
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
      approval:
        'Someone else who can approve changes must approve each change.',
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
            'Someone else who can approve changes must approve each change.',
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

const run = (
  id: string,
  createdAt: string,
  patch: Partial<WorkflowRunView>,
): WorkflowRunView => ({
  id,
  createdAt,
  version: '0.1.0',
  versionDigest: 'a'.repeat(64),
  activationId: '99999999-9999-4999-8999-999999999999',
  evidenceKind: 'live',
  execution: 'accepted',
  verification: 'verified',
  reason: 'verified',
  story: {
    context: 'The diagnosis was ready for a proposed correction.',
    decision: 'The expected correction was confirmed by verification.',
    action: 'Set the order shipping method to the mapped method.',
    verification:
      'The expected correction was verified. This does not establish any later business outcome.',
  },
  trigger: { kind: 'exception', issueType: 'workflow_failure' },
  subject: { kind: 'order', id: '44444444-4444-4444-8444-444444444444' },
  actor: { kind: 'user', id: 'ada' },
  contextDigest: 'c'.repeat(64),
  steps: [],
  ...patch,
});
const runs: WorkflowRunView[] = [
  run('10000000-0000-4000-8000-000000000001', '2026-10-15T09:40:00.000Z', {
    execution: 'awaiting_approval',
    verification: 'not_verified',
    reason: 'approval_required',
    story: {
      context: 'The diagnosis was ready for a proposed correction.',
      decision:
        'Waiting for someone else who can approve changes to decide on the proposed change.',
      action: 'Set the order shipping method to the mapped method.',
      verification: 'The expected correction has not been verified.',
    },
  }),
  run('10000000-0000-4000-8000-000000000002', '2026-10-15T08:12:00.000Z', {
    execution: 'accepted',
    verification: 'failed',
    reason: 'verification_failed',
    story: {
      context: 'The diagnosis was ready for a proposed correction.',
      decision:
        'The observed result did not match the expected correction. Operator review is required.',
      action: 'Set the order shipping method to the mapped method.',
      verification: 'The expected correction was not observed.',
    },
  }),
  run('10000000-0000-4000-8000-000000000003', '2026-10-14T16:05:00.000Z', {}),
  run('10000000-0000-4000-8000-000000000004', '2026-10-14T11:30:00.000Z', {
    trigger: { kind: 'manual' },
    subject: {
      kind: 'inventory_position',
      id: '77777777-7777-4777-8777-777777777777',
    },
    processState: 'waiting',
    reason: 'The workflow is waiting before its next step.',
    processSteps: [
      {
        stepId: 'eligible',
        kind: 'read',
        state: 'completed',
        values: {},
        evidenceRefs: ['observation:1'],
        recordedAt: '2026-10-14T11:30:02.000Z',
      },
      {
        stepId: 'recheck',
        kind: 'wait',
        state: 'waiting',
        values: {},
        evidenceRefs: [],
        recordedAt: '2026-10-14T11:30:03.000Z',
      },
    ],
  }),
];

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
    | 'runs'
    | undefined;
}) {
  const [filters, setFilters] = useState<WorkflowFilters>({});
  const [collapsed, setCollapsed] = useState<readonly string[]>([]);

  return (
    <>
      <StoryShell page="workflows">
        {['member', 'admin', 'blocked', 'runs'].includes(state) ? (
          <div className="workflows-page workflow-detail-page">
            <WorkflowDetailView
              {...(state === 'runs'
                ? {
                    runCount: runs.length,
                    runsNeedLook: true,
                    runs: (
                      <WorkflowRuns
                        detail={detail}
                        organizationId={organizationId}
                        runs={runs}
                        people={[]}
                        loading={false}
                        refreshing={false}
                        refetch={() => {}}
                        refresh={async () => {}}
                      />
                    ),
                  }
                : {})}
              detail={
                state === 'member'
                  ? detail
                  : state === 'runs'
                    ? {
                        ...detail,
                        summary: {
                          ...summary,
                          readiness: readiness({
                            enablement: 'enabled',
                            nextAction: {
                              label: 'Nothing needed',
                              description: 'The workflow is running.',
                              repair: null,
                            },
                            outcomes: {
                              runs: 4,
                              verified: 1,
                              unresolved: 1,
                              inProgress: 2,
                              latest: {
                                runId: runs[0]!.id,
                                state: 'in_progress',
                                at: runs[0]!.createdAt,
                                summary: 'Waiting for approval.',
                              },
                              recent: runs.slice(0, 4).map((run, index) => ({
                                state: (
                                  [
                                    'in_progress',
                                    'unresolved',
                                    'in_progress',
                                    'verified',
                                  ] as const
                                )[index]!,
                                at: run.createdAt,
                              })),
                            },
                          }),
                        },
                      }
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
                              trigger: {
                                kind: 'condition' as const,
                                field: 'belowMinimum',
                                equals: true,
                              },
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
                              trigger: { kind: 'manual' as const },
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
            collapsed={collapsed}
            onCollapsedChange={(key, closed) =>
              setCollapsed((previous) => [
                ...previous.filter((item) => item !== key),
                ...(closed ? [key] : []),
              ])
            }
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
  const [queryClient] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  );
  const [router] = useState(() =>
    createRouter({
      history: createMemoryHistory(),
      routeTree: createRootRoute({
        component: () => <Preview state={state} />,
      }),
    }),
  );

  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
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
      canvas.getByRole('searchbox', { name: 'Search workflows' }),
      'not found',
    );
    await expect(
      await canvas.findByRole('heading', { name: 'No matching workflows' }),
    ).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Clear' }));
    await expect(
      await canvas.findByRole('link', { name: summary.name }),
    ).toBeVisible();
    // Rows say what starts each workflow and how its latest runs ended, oldest first.
    await expect(
      canvas.getAllByText('Stock falls below the minimum')[0],
    ).toBeVisible();
    await expect(
      canvas.getAllByRole('img', {
        name: 'Last 3 runs, oldest first: 2 verified and 1 in progress',
      })[0],
    ).toBeVisible();
    // Groups collapse and expand; the page keeps that as a personal setting.
    const group = canvas.getByRole('button', { name: /^Needs attention/ });
    await userEvent.click(group);
    await expect(group).toHaveAttribute('aria-expanded', 'false');
    await expect(
      canvas.queryByRole('link', { name: 'Replenish low stock' }),
    ).not.toBeInTheDocument();
    await userEvent.click(group);
    await expect(
      canvas.getByRole('link', { name: 'Replenish low stock' }),
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
      canvas.getByRole('heading', { name: 'Review activation' }),
    ).toBeVisible();
    await expect(canvas.getByText('Off', { exact: true })).toBeVisible();
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

/** An enabled workflow whose connection lost access can't run and leads with the repair. */
export const BlockedDetail: Story = {
  args: { state: 'blocked' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole('heading', {
        name: 'Repair access in Connections',
      }),
    ).toBeVisible();
    await expect(canvas.getByText('Can’t run', { exact: true })).toBeVisible();
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
      canvas.getByRole('tab', { name: 'Needs attention 2' }),
    );
    await expect(
      canvas.getByRole('link', { name: 'Replenish low stock' }),
    ).toBeVisible();
    await expect(
      canvas.queryByRole('link', { name: 'Correct a delivery address' }),
    ).not.toBeInTheDocument();
    // Off and blocked needs setup; it isn't something going wrong.
    await expect(
      canvas.queryByRole('link', { name: 'Calculate replenishment quantity' }),
    ).not.toBeInTheDocument();
    await userEvent.click(canvas.getByRole('tab', { name: 'On 2' }));
    await expect(
      canvas.getByRole('link', { name: summary.name }),
    ).toBeVisible();
    await expect(
      canvas.getByRole('link', { name: 'Review 1 waiting decision' }),
    ).toBeVisible();
    await userEvent.click(
      canvas.getByRole('button', { name: 'Add System filter' }),
    );
    await userEvent.click(await body.findByRole('button', { name: 'Luma' }));
    await expect(
      canvas.queryByRole('link', { name: summary.name }),
    ).not.toBeInTheDocument();
    const search = canvas.getByRole('searchbox', { name: 'Search workflows' });
    await userEvent.type(search, 'address');
    await expect(
      await canvas.findByRole('heading', { name: 'No matching workflows' }),
    ).toBeVisible();
    await userEvent.clear(search);
    await userEvent.click(
      await canvas.findByRole('button', {
        name: 'Remove System filter: Luma',
      }),
    );
    await expect(
      await canvas.findByRole('link', { name: summary.name }),
    ).toBeVisible();
    await userEvent.click(canvas.getByRole('tab', { name: /^All workflows/ }));
    await userEvent.type(search, 'commitments');
    await expect(
      await canvas.findByRole('link', { name: 'Replenish low stock' }),
    ).toBeVisible();
    await waitFor(() =>
      expect(
        canvas.queryByRole('link', { name: summary.name }),
      ).not.toBeInTheDocument(),
    );
    await userEvent.clear(search);
    await userEvent.click(
      canvas.getByRole('button', { name: 'Add Starts when filter' }),
    );
    await expect(
      body.queryByRole('button', { name: 'Scheduled' }),
    ).not.toBeInTheDocument();
    await userEvent.click(
      await body.findByRole('button', { name: 'Started by a person' }),
    );
    await expect(
      await canvas.findByRole('link', {
        name: 'Calculate replenishment quantity',
      }),
    ).toBeVisible();
    await expect(
      canvas.queryByRole('link', { name: 'Replenish low stock' }),
    ).not.toBeInTheDocument();
  },
};

export const DetailNavigation: Story = {
  args: { state: 'admin' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole('tab', { name: 'How it works' }),
    ).toHaveAttribute('aria-selected', 'true');
    await userEvent.click(canvas.getByRole('tab', { name: 'Details' }));
    await expect(
      await canvas.findByRole('heading', { name: 'Technical details' }),
    ).toBeVisible();
    await userEvent.click(canvas.getByRole('tab', { name: 'Setup' }));
    await expect(
      await canvas.findByRole('heading', { name: 'Activations' }),
    ).toBeVisible();
  },
};

/** Recent runs filter to the ones that need a look and open into their evidence. */
export const Runs: Story = {
  args: { state: 'runs' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('tab', { name: /^Runs/ }));
    await userEvent.click(
      await canvas.findByRole('tab', { name: 'Needs a look 2' }),
    );
    const failed = canvas.getByRole('button', {
      name: /Verification failed/,
    });
    await expect(failed).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(failed);
    await expect(failed).toHaveAttribute('aria-expanded', 'true');
    await expect(
      canvas.getByText('The expected correction was not observed.'),
    ).toBeVisible();
    // History narrows to the failed run's record and back.
    await userEvent.click(
      canvas.getByRole('button', { name: 'Show all 3 runs for this record' }),
    );
    await expect(
      canvas.getByText('Showing 3 recent runs for one record (Order).'),
    ).toBeVisible();
    await expect(canvas.getByRole('tab', { name: 'All 3' })).toBeVisible();
    await userEvent.click(
      canvas.getByRole('button', { name: 'Show all runs' }),
    );
    await expect(canvas.getByRole('tab', { name: /^All 4/ })).toBeVisible();
    await userEvent.click(canvas.getByRole('tab', { name: 'Verified 1' }));
    await expect(
      canvas.queryByRole('button', { name: /Verification failed/ }),
    ).not.toBeInTheDocument();
  },
};
