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
  actorId: 'Ada',
  actorKind: 'user',
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
    | undefined;
}) {
  const [filters, change] = useState<ActivityFilters>({
    from: '2026-09-01',
    to: '2026-09-22',
  });

  return (
    <>
      <style>{appStyles}</style>
      <ActivityView
        organizationId="33333333-3333-4333-8333-333333333333"
        filters={filters}
        change={change}
        refresh={() => {}}
        loading={state === 'loading'}
        offline={state === 'offline'}
        newEvents={state === 'ready'}
        error={
          state === 'unavailable' || state === 'stale'
            ? 'Activity is unavailable. Loaded events may be outdated.'
            : state === 'access'
              ? 'Workspace access changed.'
              : undefined
        }
        page={
          ['loading', 'unavailable', 'access'].includes(state)
            ? undefined
            : {
                visibility: 'admin',
                items: state === 'empty' ? [] : [item],
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
    await userEvent.click(
      await canvas.findByRole('button', { name: /execution.completed/ }),
    );
    await expect(
      canvas.getByText('inconclusive', { exact: true }),
    ).toBeVisible();
    await expect(
      canvas.getByRole('link', { name: 'Open issue and evidence' }),
    ).toBeVisible();
  },
};

export const Loading: Story = { args: { state: 'loading' } };

export const Empty: Story = { args: { state: 'empty' } };

export const Unavailable: Story = { args: { state: 'unavailable' } };

export const Stale: Story = { args: { state: 'stale' } };

export const Offline: Story = { args: { state: 'offline' } };

export const AccessLost: Story = { args: { state: 'access' } };

export const Narrow: Story = {
  globals: { viewport: { value: 'mobile1', isRotated: false } },
};
