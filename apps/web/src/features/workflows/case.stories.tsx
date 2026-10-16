import type {
  WorkflowActivationView,
  WorkflowDetail,
  WorkflowReadiness,
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
import { expect, userEvent, within } from 'storybook/test';

import { CaseWorkflowAction, CaseWorkflowPanel } from './case';

const readiness = (
  overrides: Partial<WorkflowReadiness> = {},
): WorkflowReadiness => ({
  enablement: 'not_enabled',
  state: 'ready',
  issues: [],
  coverage: {
    unit: 'open inventory mismatch case',
    covered: 0,
    ready: null,
    explanation:
      'No inventory mismatch case starts this workflow until someone turns it on. 2 open now.',
  },
  approval: {
    mode: 'every_action',
    summary:
      'Someone else who can approve changes approves every change before Luma sends it.',
    details: [
      'Changes are medium risk or higher, so workspace policy always requires approval.',
    ],
  },
  waiting: { count: 0, repair: null },
  outcomes: null,
  nextAction: {
    label: 'Turn on',
    description: 'Nothing runs until someone whose role allows it turns it on.',
    repair: { label: 'Turn on', destination: 'workflow_rules' },
  },
  ...overrides,
});

const active: WorkflowActivationView = {
  id: '55555555-5555-4555-8555-555555555555',
  version: '1.0.0',
  versionDigest: 'b'.repeat(64),
  artifactDigest: 'c'.repeat(64),
  policyVersion: 'v1',
  active: true,
  grants: { principalIds: ['ada'], connectionIds: [], targetIds: [] },
  reviewedBy: 'ada',
  reviewedAt: '2026-10-06T09:00:00.000Z',
};

type State = 'off' | 'on' | 'other' | 'blocked' | 'member';

const on = (state: State) => state === 'on' || state === 'other';

const detail = (state: State): WorkflowDetail => ({
  presentation: 'workflows.case',
  summary: {
    id: 'shopify-stock-correction',
    name: 'Correct Shopify stock from the ERP',
    trigger: { kind: 'exception', issueType: 'inventory_mismatch' },
    purpose:
      'When Shopify shows a different available quantity than the ERP for linked stock, propose setting Shopify to the ERP quantity.',
    category: 'inventory',
    capability: 'inventory.available.reconcile',
    systems: [],
    availableVersion: '1.0.0',
    status: on(state) ? 'active' : 'inactive',
    blockers: [],
    activeVersions: on(state) ? ['1.0.0'] : [],
    readiness: on(state)
      ? readiness({
          enablement: 'enabled',
          coverage: {
            unit: 'open inventory mismatch case',
            covered: 2,
            ready: null,
            explanation:
              'Luma starts one run for each inventory mismatch case that detection confirms. 2 open now.',
          },
        })
      : state === 'blocked'
        ? readiness({
            state: 'blocked',
            issues: [
              {
                code: 'requirement',
                severity: 'blocking',
                message:
                  'Reconnect a Shopify store and allow inventory changes.',
                scope: null,
                repair: {
                  label: 'Open Connections',
                  destination: 'connections',
                },
              },
            ],
          })
        : readiness(),
  },
  versions: [
    {
      version: '1.0.0',
      digest: 'b'.repeat(64),
      compatible: state !== 'blocked',
      blockers: [],
      capability: 'inventory.available.reconcile',
      capabilityVersion: '0',
      targetKind: 'inventory_position',
      category: 'inventory',
      format: 'workflow/2',
      applicability: {
        trigger: { kind: 'exception', issueType: 'inventory_mismatch' },
        subjectKind: 'inventory_position',
      },
      inputs: { activationId: 'string', caseId: 'string' },
      context: {
        kind: 'inventory_mismatch',
        fields: { severity: 'string' },
        maxAgeSeconds: 300,
      },
      finalOutcome: 'Shopify shows the ERP quantity, confirmed by a fresh read',
      systems: [],
      approval:
        'Each change waits for policy approval by someone else who can approve changes.',
      permissions: ['inventory.available.reconcile'],
      provenance: {
        kind: 'native',
        reference: 'shopify-case-workflows/1',
        authoredBy: 'Luma',
        evidenceRefs: ['shopify-inventory-reconciliation/1'],
      },
      representation: '{}',
      steps: [],
    },
  ],
  activations: on(state) ? [active] : [],
  connections: [],
  policyVersion: 'v1',
  principalId: state === 'other' ? 'grace' : 'ada',
  canManage: state !== 'member',
  evaluationEvidence: 'unavailable',
  people: [
    {
      kind: 'member',
      id: 'ada',
      name: 'Ada Lovelace',
      email: 'ada@example.test',
      workflow: null,
    },
    {
      kind: 'member',
      id: 'grace',
      name: 'Grace Hopper',
      email: 'grace@example.test',
      workflow: null,
    },
  ],
});

function Preview({ state }: { state: State }) {
  const [client] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  );
  const [router] = useState(() =>
    createRouter({
      history: createMemoryHistory(),
      routeTree: createRootRoute({
        component: () => (
          <QueryClientProvider client={client}>
            <main
              className="workflows-page"
              style={{ maxWidth: 760, margin: 'auto', padding: 24 }}
            >
              <div className="workflow-stack">
                <div>
                  <CaseWorkflowAction
                    organizationId="org"
                    detail={detail(state)}
                    notify={() => undefined}
                  />
                </div>
                <CaseWorkflowPanel detail={detail(state)} />
              </div>
            </main>
          </QueryClientProvider>
        ),
      }),
    }),
  );

  return <RouterProvider router={router} />;
}

const meta = {
  title: 'Workflows/Case workflow',
  component: Preview,
  parameters: { layout: 'fullscreen' },
  args: { state: 'off' },
} satisfies Meta<typeof Preview>;

export default meta;

type Story = StoryObj<typeof meta>;

/** Turning it on asks the person to review who approves its changes first. */
export const Off: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const body = within(canvasElement.ownerDocument.body);
    await expect(await canvas.findByText('Off')).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Turn on' }));
    const dialog = within(await body.findByRole('dialog'));
    const submit = dialog.getByRole('button', { name: 'Turn on' });
    await expect(submit).toBeDisabled();
    await userEvent.click(
      dialog.getByRole('checkbox', {
        name: 'I reviewed this version and who approves its changes.',
      }),
    );
    await expect(submit).toBeEnabled();
  },
};

export const On: Story = {
  args: { state: 'on' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByText(/Runs use your permissions/),
    ).toBeVisible();
    await expect(
      canvas.getByRole('button', { name: 'Turn off' }),
    ).toBeVisible();
  },
};

/** Someone else turned it on, so runs use that person's permissions. */
export const OnBySomeoneElse: Story = {
  args: { state: 'other' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByText(/Turned on by Ada Lovelace/),
    ).toBeVisible();
  },
};

export const Blocked: Story = {
  args: { state: 'blocked' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole('button', { name: 'Turn on' }),
    ).toBeDisabled();
  },
};

export const Member: Story = {
  args: { state: 'member' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByText(
        'Your role doesn’t allow enabling workflows, so you can’t turn this workflow on or off.',
      ),
    ).toBeVisible();
  },
};

export const Dark: Story = {
  args: { state: 'on' },
  globals: { theme: 'dark' },
};

export const Narrow: Story = {
  args: { state: 'off' },
  globals: { viewport: { value: 'mobile1', isRotated: false } },
};
