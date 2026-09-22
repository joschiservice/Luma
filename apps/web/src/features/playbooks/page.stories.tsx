import type { PlaybookDetail, PlaybookSummary } from '@luma/api-contract';
import type { Meta, StoryObj } from '@storybook/react-vite';
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { useState } from 'react';
import { expect, userEvent, within } from 'storybook/test';

import appStyles from '../../styles.css?inline';
import { PlaybookDetailView } from './detail';
import { type PlaybookFilters, PlaybookLibraryView } from './library';

const organizationId = '22222222-2222-4222-8222-222222222222';
const summary: PlaybookSummary = {
  id: 'shipping-method-correction',
  name: 'Correct an order shipping method',
  purpose:
    'Apply the mapped shipping method to an eligible order and verify the correction.',
  capability: 'orders.shipping-method.write',
  issueType: 'workflow_failure',
  systems: ['jtl-cloud', 'jtl-onprem'],
  availableVersion: '0.1.0',
  activeVersions: [],
  status: 'inactive',
  blockers: [],
};
const detail: PlaybookDetail = {
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
      issueType: summary.issueType,
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
    | 'unavailable'
    | 'revoked'
    | undefined;
}) {
  const [filters, setFilters] = useState<PlaybookFilters>({});

  return (
    <>
      <style>{appStyles}</style>
      <div style={{ padding: 24, maxWidth: 1200, margin: 'auto' }}>
        {state === 'member' ? (
          <PlaybookDetailView
            detail={detail}
            organizationId={organizationId}
            refresh={async () => {}}
            accessLost={async () => {}}
          />
        ) : (
          <PlaybookLibraryView
            organizationId={organizationId}
            items={
              state === 'empty'
                ? []
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
                  ]
            }
            filters={filters}
            change={setFilters}
            loading={state === 'loading'}
            error={
              state === 'error'
                ? 'Playbooks are unavailable. Check your connection and retry.'
                : undefined
            }
            refresh={() => {}}
          />
        )}
      </div>
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
  title: 'Playbooks/Library',
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
    await userEvent.type(canvas.getByLabelText('Search by name'), 'not found');
    await expect(
      canvas.getByRole('heading', { name: 'No matching playbooks' }),
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
