import type { WorkflowDetail, WorkflowSummary } from '@luma/api-contract';
import { WorkspaceAccountMenu } from '@luma/ui/components/workspace/workspace-account-menu';
import type { Meta, StoryObj } from '@storybook/react-vite';
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { BookOpen } from 'lucide-react';
import { useState } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';

import appStyles from '../../styles.css?inline';
import { Brand } from '../identity/common';
import { WorkspaceLayout } from '../identity/workspace-layout';
import { WorkflowDetailView } from './detail';
import { type WorkflowFilters, WorkflowLibraryView } from './library';

const organizationId = '22222222-2222-4222-8222-222222222222';
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
      <style>{appStyles}</style>
      <WorkspaceLayout
        brand={<Brand />}
        navigation={() => (
          <nav aria-label="Main navigation">
            <a className="active" href="#">
              <BookOpen size={16} /> Workflows
            </a>
          </nav>
        )}
        context={
          <>
            <BookOpen size={16} aria-hidden="true" />
            <span>Workflows</span>
          </>
        }
        accountMenu={
          <WorkspaceAccountMenu
            name="Alex Morgan"
            workspace="Northstar Commerce"
            workspaceId="northstar"
            workspaces={[
              {
                id: 'northstar',
                name: 'Northstar Commerce',
                link: <a href="#workspace" />,
              },
            ]}
            createLink={<a href="#new-workspace" />}
          />
        }
      >
        {['member', 'admin', 'blocked'].includes(state) ? (
          <div className="workflows-page">
            <WorkflowDetailView
              detail={
                state === 'member'
                  ? detail
                  : {
                      ...detail,
                      canManage: true,
                      connections: [
                        {
                          id: '33333333-3333-4333-8333-333333333333',
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
                              : 'inactive',
                        blockers:
                          state === 'unavailable'
                            ? [
                                'Validate JTL permissions and ingest mapped orders before activation.',
                              ]
                            : [],
                      },
                      ...(state === 'ready'
                        ? [
                            {
                              ...summary,
                              id: 'inventory-correction',
                              name: 'Reconcile available inventory',
                              purpose:
                                'Compare authoritative stock and verify the quantity published to Shopify.',
                              systems: ['jtl-cloud', 'shopify'],
                              category: 'resolution',
                              status: 'active' as const,
                              activeVersions: ['0.1.0'],
                            },
                            {
                              ...summary,
                              id: 'order-recovery',
                              name: 'Recover a failed order transfer',
                              purpose:
                                'Check a failed transfer and confirm the order reaches the warehouse.',
                              systems: ['shopify', 'jtl-cloud'],
                              status: 'unavailable' as const,
                              blockers: [
                                'Validate JTL permissions before activation.',
                              ],
                            },
                            {
                              ...summary,
                              id: 'address-correction',
                              name: 'Correct a delivery address',
                              purpose:
                                'Review an address correction before updating the warehouse order.',
                              systems: ['jtl-onprem'],
                              status: 'revoked' as const,
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
      </WorkspaceLayout>
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

export const BlockedDetail: Story = { args: { state: 'blocked' } };

export const Filters: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const body = within(canvasElement.ownerDocument.body);
    await userEvent.click(canvas.getByRole('button', { name: 'Active 1' }));
    await expect(
      canvas.getByRole('link', { name: 'Reconcile available inventory' }),
    ).toBeVisible();
    await expect(
      canvas.queryByRole('link', { name: summary.name }),
    ).not.toBeInTheDocument();
    await userEvent.click(canvas.getByRole('combobox', { name: 'System' }));
    await userEvent.click(
      await body.findByRole('option', { name: 'JTL-Wawi' }),
    );
    await expect(
      canvas.getByRole('heading', { name: 'No matching workflows' }),
    ).toBeVisible();
    await userEvent.click(
      canvas.getByRole('button', { name: 'Remove JTL-Wawi filter' }),
    );
    await expect(
      canvas.getByRole('link', { name: 'Reconcile available inventory' }),
    ).toBeVisible();
    await userEvent.click(
      canvas.getByRole('button', { name: 'Clear filters' }),
    );
    await userEvent.type(
      canvas.getByLabelText('Search workflows'),
      'authoritative',
    );
    await expect(
      canvas.getByRole('link', { name: 'Reconcile available inventory' }),
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
      canvas.getByRole('button', { name: 'Compatibility' }),
    );
    await expect(
      canvas.getByRole('region', { name: 'Compatibility' }),
    ).toHaveFocus();
    await expect(
      canvas.getByRole('button', { name: 'Compatibility' }),
    ).toHaveAttribute('aria-current', 'location');
    await userEvent.click(canvas.getByRole('button', { name: 'Overview' }));
  },
};
