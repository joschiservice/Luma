import type { ActivityEvent } from '@luma/api-contract';
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

const item: ActivityEvent = {
  id: '11111111-1111-4111-8111-111111111111',
  recordedAt: '2026-09-22T10:00:00Z',
  occurredAt: '2026-09-22T09:59:00Z',
  actor: {
    kind: 'member',
    id: '33333333-3333-4333-8333-333333333333',
    name: 'Ada Lovelace',
    email: 'ada@example.test',
    workflow: { id: 'shipping-method', name: 'Correct shipping methods' },
  },
  action: 'execution.completed',
  type: 'verification',
  outcome: 'uncertain',
  exceptionId: '22222222-2222-4222-8222-222222222222',
  proposalId: null,
  attemptId: null,
  connectionId: null,
  system: 'jtl-cloud',
  resource: 'Order 1042',
  playbookId: null,
  mode: 'pilot',
  summary: 'orders.shipping-method.write',
  dispatch: 'dispatched',
  executionState: 'unknown',
  verificationPhase: null,
  failureCode: null,
  connections: [],
  verification: 'inconclusive',
  evidenceRefs: ['observation:shipping-1042'],
};

const others: ActivityEvent[] = [
  {
    ...item,
    id: '66666666-6666-4666-8666-666666666666',
    action: 'case.approve',
    type: 'decision',
    outcome: 'approved',
    actor: {
      kind: 'former_member',
      id: '77777777-7777-4777-8777-777777777777',
      name: 'Ben Ortiz',
      email: null,
      workflow: null,
    },
  },
  {
    ...item,
    id: '88888888-8888-4888-8888-888888888888',
    action: 'exception.detected',
    type: 'issue',
    outcome: 'recorded',
    actor: { kind: 'luma', id: null, name: null, email: null, workflow: null },
  },
];

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

function Preview({
  state = 'ready',
}: {
  state?:
    | 'ready'
    | 'loading'
    | 'empty'
    | 'unavailable'
    | 'stale'
    | 'offline'
    | 'access'
    | 'repair'
    | undefined;
}) {
  const [filters, change] = useState<ActivityFilters>({});

  return (
    <>
      <style>{appStyles}</style>
      <ActivityView
        organizationId="33333333-3333-4333-8333-333333333333"
        filters={filters}
        sources={sources}
        people={[
          { id: '33333333-3333-4333-8333-333333333333', label: 'Ada Lovelace' },
        ]}
        change={change}
        repair={state === 'repair' ? () => {} : undefined}
        refresh={() => {}}
        loading={state === 'loading'}
        offline={state === 'offline'}
        newEvents={state === 'ready'}
        error={
          state === 'repair'
            ? 'This view uses filters the list can’t apply.'
            : state === 'unavailable' || state === 'stale'
              ? 'Activity is unavailable. Loaded events may be outdated.'
              : state === 'access'
                ? 'Workspace access changed.'
                : undefined
        }
        page={
          ['loading', 'unavailable', 'access', 'repair'].includes(state)
            ? undefined
            : {
                visibility: 'admin',
                items: state === 'empty' ? [] : [item, ...others],
                nextCursor: null,
                coverage:
                  'Recorded events only. Older unrecorded changes are unavailable.',
              }
        }
      />
    </>
  );
}

function Routed({ state }: Parameters<typeof Preview>[0]) {
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
    await expect(
      await canvas.findByText('Ben Ortiz (former member) · jtl-cloud'),
    ).toBeVisible();
    await expect(canvas.getByText('Luma · jtl-cloud')).toBeVisible();
    await userEvent.click(
      await canvas.findByRole('button', { name: /Change attempt finished/ }),
    );
    await expect(
      canvas.getByText('Inconclusive', { exact: true }),
    ).toBeVisible();
    await expect(
      canvas.getByText(
        'Ada Lovelace · ada@example.test via Correct shipping methods',
      ),
    ).toBeVisible();
    await expect(
      canvas.getByRole('link', { name: 'Open issue and evidence' }),
    ).toBeVisible();
  },
};

export const Filtering: Story = {
  globals: { viewport: { value: 'desktop' } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const panel = within(
      canvas.getByRole('complementary', { name: 'Filters' }),
    );
    const section = (name: string) =>
      within(panel.getByRole('region', { name }));

    await expect(
      canvas.getByRole('searchbox', { name: 'Search activity' }),
    ).toBeVisible();
    // The default range always applies, so it cannot be removed.
    await expect(
      canvas.getByRole('button', {
        name: 'Edit Recorded filter: Last 30 days',
      }),
    ).toBeVisible();
    await expect(
      section('Recorded').getByRole('button', { name: 'Last 30 days' }),
    ).toHaveAttribute('aria-pressed', 'true');
    await expect(
      canvas.queryByRole('button', { name: /^Remove Recorded filter/ }),
    ).toBeNull();

    // Every value is listed in the panel; one click applies it.
    await userEvent.click(
      section('System').getByRole('button', { name: 'Shopify' }),
    );
    await expect(
      await canvas.findByRole('button', {
        name: 'Edit System filter: Shopify',
      }),
    ).toBeVisible();
    await userEvent.click(
      section('Connection').getByRole('button', { name: 'JTL warehouse' }),
    );
    await expect(
      await canvas.findByRole('button', {
        name: 'Edit Connection filter: JTL warehouse',
      }),
    ).toBeVisible();

    await userEvent.click(section('Recorded').getByText('Custom range'));
    await userEvent.type(
      section('Recorded').getByLabelText('From'),
      '2026-09-01',
    );
    await userEvent.type(
      section('Recorded').getByLabelText('Through'),
      '2026-09-22',
    );
    await userEvent.click(
      section('Recorded').getByRole('button', { name: 'Apply range' }),
    );
    await userEvent.click(
      await canvas.findByRole('button', {
        name: 'Remove Recorded filter: 1 – 22 Sept 2026',
      }),
    );
    await expect(
      await canvas.findByRole('button', {
        name: 'Edit Recorded filter: Last 30 days',
      }),
    ).toBeVisible();

    // People, Luma and workflows are offered together; several can apply at once.
    await userEvent.click(
      section('Recorded by').getByRole('button', { name: 'Me' }),
    );
    await userEvent.click(
      section('Recorded by').getByRole('button', { name: 'Luma' }),
    );
    await expect(
      section('Recorded by').getByRole('button', { name: 'Luma' }),
    ).toHaveAttribute('aria-pressed', 'true');
    // A preset stays relative: it is named as the preset whatever today is.
    await userEvent.click(
      section('Recorded').getByRole('button', { name: 'Last 7 days' }),
    );
    await expect(
      await canvas.findByRole('button', {
        name: 'Edit Recorded filter: Last 7 days',
      }),
    ).toBeVisible();

    await userEvent.click(canvas.getByRole('button', { name: 'Clear' }));
    await expect(
      canvas.queryByRole('button', { name: /^Edit System filter/ }),
    ).toBeNull();
    await expect(
      section('System').getByRole('button', { name: 'Any' }),
    ).toHaveAttribute('aria-pressed', 'true');
  },
};

export const Loading: Story = { args: { state: 'loading' } };

export const Empty: Story = { args: { state: 'empty' } };

export const Unavailable: Story = { args: { state: 'unavailable' } };

export const Stale: Story = { args: { state: 'stale' } };

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
  globals: { viewport: { value: 'mobile1', isRotated: false } },
};
