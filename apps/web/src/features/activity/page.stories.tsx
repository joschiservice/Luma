import type { ActivityEvent } from '@luma/api-contract';
import { WorkspaceTimezone } from '@luma/ui/components/primitives/workspace-date';
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
import type { ActivityFilters } from './data';
import { ActivityView } from './page';

const now = Date.now();
const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
const issueId = '22222222-2222-4222-8222-222222222222';
const proposalId = '99999999-9999-4999-8999-999999999999';
const operator = {
  kind: 'member' as const,
  id: '33333333-3333-4333-8333-333333333333',
  name: 'Ada Lovelace',
  email: 'ada@example.test',
  workflow: null,
};
const luma = {
  kind: 'luma' as const,
  id: null,
  name: null,
  email: null,
  workflow: null,
};

const base: ActivityEvent = {
  id: '11111111-1111-4111-8111-111111111111',
  recordedAt: ago(12),
  occurredAt: ago(12),
  actor: operator,
  action: 'execution.completed',
  type: 'verification',
  outcome: 'uncertain',
  exceptionId: issueId,
  proposalId,
  attemptId: '44444444-4444-4444-8444-444444444444',
  connectionId: '44444444-4444-4444-8444-444444444444',
  system: 'jtl-cloud',
  resource: '1042',
  resourceKind: 'order',
  issueClass: 'workflow_failure',
  playbookId: null,
  mode: 'pilot',
  summary: 'orders.shipping-method.write',
  dispatch: 'dispatched',
  executionState: 'unknown',
  verificationPhase: null,
  failureCode: null,
  connections: [
    { id: '44444444-4444-4444-8444-444444444444', system: 'jtl-cloud' },
  ],
  verification: 'inconclusive',
  evidenceRefs: ['observation:shipping-1042'],
};

const items: ActivityEvent[] = [
  {
    ...base,
    actor: {
      ...operator,
      workflow: { id: 'shipping-method', name: 'Correct shipping methods' },
    },
    steps: [
      {
        ...base,
        id: '55555555-5555-4555-8555-555555555551',
        recordedAt: ago(40),
        actor: luma,
        action: 'exception.detected',
        type: 'issue',
        outcome: 'recorded',
        proposalId: null,
        attemptId: null,
        summary: null,
        dispatch: null,
        executionState: null,
        verification: null,
        evidenceRefs: [],
      },
      {
        ...base,
        id: '55555555-5555-4555-8555-555555555552',
        recordedAt: ago(30),
        action: 'policy.evaluated',
        type: 'decision',
        outcome: 'recorded',
        attemptId: null,
        dispatch: null,
        executionState: null,
        verification: null,
        evidenceRefs: [],
      },
      {
        ...base,
        id: '55555555-5555-4555-8555-555555555553',
        recordedAt: ago(20),
        action: 'case.approve',
        type: 'decision',
        outcome: 'approved',
        attemptId: null,
        dispatch: null,
        executionState: null,
        verification: null,
        evidenceRefs: [],
      },
    ],
  },
  {
    ...base,
    id: '66666666-6666-4666-8666-666666666666',
    recordedAt: ago(90),
    action: 'exception.resolved',
    type: 'resolution',
    outcome: 'verified',
    issueClass: 'stuck_fulfillment',
    resourceKind: 'fulfillment',
    resource: '123e7da6-4d18-45ce-ae41-03ed4abddc59',
    mode: 'unrecorded',
    summary: null,
    executionState: null,
    verification: 'passed',
    actor: {
      kind: 'former_member',
      id: '77777777-7777-4777-8777-777777777777',
      name: 'Ben Ortiz',
      email: null,
      workflow: null,
    },
  },
  {
    ...base,
    id: '88888888-8888-4888-8888-888888888888',
    recordedAt: ago(60 * 26),
    action: 'exception.detected',
    type: 'issue',
    outcome: 'recorded',
    issueClass: 'inventory_mismatch',
    resourceKind: 'sku',
    resource: '37832c66-860f-4074-a308-b32d68e1e5c2',
    mode: 'unrecorded',
    summary: null,
    dispatch: null,
    executionState: null,
    verification: null,
    actor: luma,
  },
  {
    ...base,
    id: 'access:12',
    recordedAt: ago(60 * 27),
    action: 'member.add',
    type: 'access',
    outcome: 'recorded',
    exceptionId: null,
    proposalId: null,
    attemptId: null,
    connectionId: null,
    connections: [],
    system: null,
    issueClass: null,
    resource: null,
    resourceKind: null,
    mode: 'unrecorded',
    summary: 'Admin',
    dispatch: null,
    executionState: null,
    verification: null,
    evidenceRefs: [],
  },
];

// An event below the loaded list, read on its own when a link opens it.
const older: ActivityEvent = {
  ...base,
  id: '99999999-0000-4000-8000-000000000001',
  recordedAt: ago(60 * 24 * 12),
  action: 'execution.completed',
  outcome: 'failed',
  failureCode: 'provider_rejected',
  executionState: 'failed',
  verification: null,
  mode: 'unrecorded',
};

const sources = [
  {
    id: '44444444-4444-4444-8444-444444444444',
    label: 'JTL warehouse',
    system: 'jtl-cloud',
  },
  {
    id: '55555555-5555-4555-8555-555555555555',
    label: 'Main store',
    system: 'shopify',
  },
];

type State =
  | 'ready'
  | 'open'
  | 'older'
  | 'missing'
  | 'exported'
  | 'loading'
  | 'empty'
  | 'unavailable'
  | 'offline'
  | 'access'
  | 'repair';

function Preview({ state = 'ready' }: { state?: State | undefined }) {
  const [filters, change] = useState<ActivityFilters>(
    state === 'open'
      ? { event: items[0]!.id }
      : state === 'older'
        ? { event: older.id }
        : state === 'missing'
          ? { event: 'not-loaded' }
          : {},
  );
  const [exported, setExported] = useState(state === 'exported');
  const listed = ['loading', 'unavailable', 'access', 'repair'].includes(state)
    ? undefined
    : state === 'empty'
      ? []
      : items;

  return (
    <WorkspaceTimezone value="Europe/Berlin">
      <style>{appStyles}</style>
      <ActivityView
        organizationId="33333333-3333-4333-8333-333333333333"
        filters={filters}
        sources={sources}
        people={[{ id: operator.id, label: 'Ada Lovelace' }]}
        change={change}
        repair={state === 'repair' ? () => {} : undefined}
        refresh={() => {}}
        loading={state === 'loading'}
        offline={state === 'offline'}
        newCount={state === 'ready' ? 2 : undefined}
        older={{ more: true, loading: false, failed: false, load: () => {} }}
        opened={state === 'older' ? older : undefined}
        counts={{
          total: 48,
          attention: 3,
          outcomes: { verified: 12, uncertain: 2, failed: 1 },
        }}
        exporting={{
          run: () => setExported(true),
          pending: false,
          result: exported ? { rows: 48, truncated: false } : undefined,
        }}
        error={
          state === 'repair'
            ? 'This view uses filters the list can’t apply.'
            : state === 'unavailable'
              ? 'Activity couldn’t be updated. The events shown may be out of date.'
              : state === 'access'
                ? 'Your access to this workspace changed. Activity is no longer available.'
                : undefined
        }
        items={listed}
      />
    </WorkspaceTimezone>
  );
}

function Routed({ state }: { state?: State | undefined }) {
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
  title: 'Activity/Workspace history',
  component: Preview,
  parameters: { layout: 'fullscreen' },
  render: (args) => <Routed {...args} />,
} satisfies Meta<typeof Preview>;

export default meta;

type Story = StoryObj<typeof meta>;

export const History: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // Days head the list, and rows say what each event concerns.
    await expect(
      await canvas.findByRole('heading', { name: /^Today/ }),
    ).toBeVisible();
    await expect(
      canvas.getByRole('heading', { name: /^Yesterday/ }),
    ).toBeVisible();
    await expect(
      canvas.getByText(
        'Fulfillment delay · Ben Ortiz (former member) · JTL Cloud',
      ),
    ).toBeVisible();
    // Access changes are named by what happened, with the role as context.
    await expect(canvas.getByText('Member added')).toBeVisible();
    await expect(canvas.getByText('Show 2 new events')).toBeVisible();

    await userEvent.click(
      canvas.getByRole('link', {
        name: /^Change the order’s shipping method\..*Outcome unclear/,
      }),
    );
    const preview = within(
      await canvas.findByRole('region', { name: 'Event details' }),
    );
    await expect(
      preview.getByText(/Luma couldn’t tell whether this took effect/),
    ).toBeVisible();
    await expect(
      preview.getByRole('link', { name: 'Open issue and evidence' }),
    ).toBeVisible();
    // Connections are named; each step's own details repeat them.
    await expect(preview.getAllByText('JTL warehouse')[0]).toBeVisible();
    // Earlier steps tell the story; routine rule checks wait behind a toggle.
    await expect(preview.getByText('Issue detected')).toBeVisible();
    await expect(preview.getByText('Change approved')).toBeVisible();
    await expect(
      preview.queryByText('Approval rules checked'),
    ).not.toBeInTheDocument();
    await userEvent.click(
      preview.getByRole('button', { name: 'Show 1 routine step' }),
    );
    await expect(preview.getByText('Approval rules checked')).toBeVisible();
  },
};

export const QuickViews: Story = {
  globals: { viewport: { value: 'desktop' } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const views = within(
      await canvas.findByRole('tablist', { name: 'Activity by outcome' }),
    );
    await expect(views.getByRole('tab', { name: /^All/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    // The default range always applies, so it cannot be removed.
    await expect(
      canvas.getByRole('button', {
        name: 'Edit Recorded filter: Last 30 days',
      }),
    ).toBeVisible();
    await expect(
      canvas.queryByRole('button', { name: /^Remove Recorded filter/ }),
    ).toBeNull();

    // "Needs a look" is the outcome filter's failed, unclear and escalated outcomes.
    await userEvent.click(views.getByRole('tab', { name: /^Needs a look/ }));
    await expect(
      await canvas.findByRole('button', {
        name: 'Edit Outcome filter: Escalated, Failed or Outcome unclear',
      }),
    ).toBeVisible();
    await expect(
      views.getByRole('tab', { name: /^Needs a look/ }),
    ).toHaveAttribute('aria-selected', 'true');
    await userEvent.click(views.getByRole('tab', { name: /^All/ }));
    await expect(
      canvas.queryByRole('button', { name: /^Edit Outcome filter/ }),
    ).toBeNull();
  },
};

export const Keyboard: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('heading', { name: /^Today/ });
    await userEvent.keyboard('j');
    await expect(
      canvas.getByRole('link', {
        name: /^Change the order’s shipping method\./,
      }),
    ).toHaveFocus();
    await userEvent.keyboard(' ');
    await expect(
      await canvas.findByRole('region', { name: 'Event details' }),
    ).toBeVisible();
    // J moves the open event along with focus.
    await userEvent.keyboard('j');
    await expect(
      within(canvas.getByRole('region', { name: 'Event details' })).getByText(
        /A separate, fresh read confirmed/,
      ),
    ).toBeVisible();
    await userEvent.keyboard('{Escape}');
    await expect(
      canvas.queryByRole('region', { name: 'Event details' }),
    ).toBeNull();
    await expect(
      canvas.getByRole('link', { name: /^Issue resolved\./ }),
    ).toHaveFocus();
  },
};

export const OpenEvent: Story = { args: { state: 'open' } };

export const EventNotLoaded: Story = { args: { state: 'missing' } };

/** A link opens an event below the loaded list; it is read on its own. */
export const OlderEvent: Story = {
  args: { state: 'older' },
  play: async ({ canvasElement }) => {
    const preview = within(
      await within(canvasElement).findByRole('region', {
        name: 'Event details',
      }),
    );
    await expect(preview.getByText(/This step failed/)).toBeVisible();
  },
};

export const Export: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // Each quick view counts what it lists; attention counts stand out.
    await expect(
      await canvas.findByRole('tab', { name: /^Needs a look\s*3$/ }),
    ).toBeVisible();
    await expect(
      canvas.getByRole('tab', { name: /^Verified\s*12$/ }),
    ).toBeVisible();
    await userEvent.click(
      canvas.getByRole('button', { name: 'Export as CSV' }),
    );
    await expect(await canvas.findByText('Exported 48 events.')).toBeVisible();
  },
};

export const Loading: Story = { args: { state: 'loading' } };

export const Empty: Story = { args: { state: 'empty' } };

export const Unavailable: Story = { args: { state: 'unavailable' } };

export const Offline: Story = { args: { state: 'offline' } };

export const AccessLost: Story = { args: { state: 'access' } };

export const NeedsRepair: Story = {
  args: { state: 'repair' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole('button', {
        name: 'Remove unsupported conditions',
      }),
    ).toBeVisible();
  },
};

export const Narrow: Story = {
  args: { state: 'open' },
  globals: { viewport: { value: 'mobile1', isRotated: false } },
};
