import { IssueDetailViews } from '@luma/ui/components/issues/issue-collection';
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

import appStyles from '../../styles.css?inline';
import { CaseShadow } from './case';
import { ShadowReport } from './report';
import {
  exceptionId,
  mockShadow,
  organizationId,
  type PreviewState,
  requests,
  workflow,
} from './storybook-support';

function Preview({ state = 'ready' }: { state?: PreviewState }) {
  const [client] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  );
  const [router] = useState(() =>
    createRouter({
      history: createMemoryHistory(),
      routeTree: createRootRoute({
        component: () => (
          <QueryClientProvider client={client}>
            <style>{appStyles}</style>
            <main
              className="workflows-page"
              style={{
                maxWidth: state.startsWith('report') ? 1180 : 740,
                margin: 'auto',
                padding: 16,
              }}
            >
              <h1>
                {state.startsWith('report')
                  ? 'Correct an order shipping method'
                  : 'Order 1042'}
              </h1>
              {!state.startsWith('report') ? <h2>Case investigation</h2> : null}
              {state.startsWith('report') ? (
                <ShadowReport
                  organizationId={organizationId}
                  workflow={workflow}
                />
              ) : (
                <IssueDetailViews issueTitle="Order 1042">
                  <CaseShadow
                    organizationId={organizationId}
                    exceptionId={exceptionId}
                  />
                </IssueDetailViews>
              )}
            </main>
          </QueryClientProvider>
        ),
      }),
    }),
  );

  return <RouterProvider router={router} />;
}

const meta = {
  title: 'Shadow/Evaluation',
  component: Preview,
  parameters: { layout: 'fullscreen' },
  beforeEach: ({ args }) => mockShadow(args.state ?? 'ready'),
} satisfies Meta<typeof Preview>;

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * Picks an option from a select and waits for its popup to close. A closing popup stays mounted
 * without pointer events, so the next select could otherwise find its options instead.
 */
async function choose(
  canvas: ReturnType<typeof within>,
  label: string,
  option: string,
) {
  await userEvent.click(await canvas.findByRole('combobox', { name: label }));
  await userEvent.click(
    await within(document.body).findByRole('option', { name: option }),
  );
  await waitFor(() =>
    expect(
      within(document.body).queryByRole('listbox'),
    ).not.toBeInTheDocument(),
  );
}

export const Case: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByText('Preview only. Nothing was changed.'),
    ).toBeVisible();
    await expect(
      canvas.getByText('Should succeed if the assumptions hold'),
    ).toBeVisible();
    await expect(
      canvas.getByText('Not checked yet', { selector: 'dd' }),
    ).toBeVisible();
  },
};

export const Evaluate: Story = {
  args: { state: 'empty' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      await canvas.findByRole('button', { name: 'Run test' }),
    );
    await expect(
      await canvas.findByText('Preview only. Nothing was changed.'),
    ).toBeVisible();
    await expect(requests.filter((r) => r.method === 'POST')).toHaveLength(1);
  },
};

export const RetryEvaluation: Story = {
  args: { state: 'uncertain' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      await canvas.findByRole('button', { name: 'Run test' }),
    );
    await userEvent.click(
      await canvas.findByRole('button', { name: 'Retry test' }),
    );
    await expect(
      await canvas.findByText('Preview only. Nothing was changed.'),
    ).toBeVisible();
    const writes = requests.filter((r) => r.method === 'POST');
    await expect(writes).toHaveLength(2);
    await expect(writes[0]!.body).toEqual(writes[1]!.body);
  },
};

export const RecordReview: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await choose(canvas, 'Was a change needed?', 'Yes');
    await choose(canvas, 'Should this Workflow handle this issue?', 'Yes');
    await choose(canvas, 'What did your team do?', 'Made the proposed change');
    await userEvent.click(await canvas.findByRole('checkbox'));
    await userEvent.click(canvas.getByRole('button', { name: 'Save review' }));
    await expect(
      await canvas.findByRole('heading', {
        name: 'Review saved',
      }),
    ).toBeVisible();
    await expect(
      canvas.queryByRole('button', { name: 'Save review' }),
    ).not.toBeInTheDocument();
  },
};

export const MissingCandidate: Story = { args: { state: 'no_candidate' } };

export const Member: Story = {
  args: { state: 'member' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByText(
        'Your role doesn’t allow testing Workflows. Ask a workspace owner or admin for access.',
      ),
    ).toBeVisible();
    await expect(
      canvas.queryByRole('button', { name: 'Run test' }),
    ).not.toBeInTheDocument();
  },
};

export const AccessDenied: Story = { args: { state: 'denied' } };

export const Unavailable: Story = { args: { state: 'error' } };

export const Comparisons: Story = {
  args: { state: 'report' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('1 issue tested')).toBeVisible();
    await expect(canvas.getAllByText('Not enough data').length).toBeGreaterThan(
      0,
    );
    await userEvent.click(canvas.getByText('Show test details'));
    await expect(
      await canvas.findByText('Confirmed', { selector: 'dd' }),
    ).toBeVisible();
    await userEvent.clear(canvas.getByLabelText('From (UTC)'));
    await userEvent.type(canvas.getByLabelText('From (UTC)'), '2026-01-01');
    await userEvent.click(canvas.getByRole('button', { name: 'Apply dates' }));
    await expect(
      await canvas.findByText(/Showing 1 Jan 2026 through/),
    ).toBeVisible();
  },
};

export const EmptyComparisons: Story = { args: { state: 'report_empty' } };

export const Narrow: Story = {
  globals: { viewport: { value: 'mobile1', isRotated: false } },
};

export const AlternativeAction: Story = {
  args: { state: 'no_candidate' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    for (const label of [
      'Was a change needed?',
      'Should this Workflow handle this issue?',
    ]) {
      await choose(canvas, label, 'Yes');
    }
    await choose(canvas, 'What did your team do?', 'Made a different change');
    await userEvent.type(
      canvas.getByLabelText('Change type'),
      'orders.shipping-method.write',
    );
    await userEvent.type(
      canvas.getByLabelText('Record ID'),
      '55555555-5555-4555-8555-555555555555',
    );
    await userEvent.click(
      canvas.getByRole('button', { name: 'Add expected result' }),
    );
    await userEvent.type(
      canvas.getByLabelText('Field name'),
      'shippingMethodId',
    );
    await userEvent.type(
      canvas.getByLabelText('Value', { exact: true }),
      'STANDARD',
    );
    await userEvent.click(await canvas.findByRole('checkbox'));
    await userEvent.click(canvas.getByRole('button', { name: 'Save review' }));
    await expect(
      await canvas.findByRole('heading', {
        name: 'Review saved',
      }),
    ).toBeVisible();
    await expect(
      requests.find((r) => r.path.endsWith('/review'))?.body.operatorAction,
    ).toMatchObject({
      target: { id: '55555555-5555-4555-8555-555555555555' },
      expectedPostcondition: { shippingMethodId: 'STANDARD' },
    });
  },
};

export const RetryReview: Story = {
  args: { state: 'review_uncertain' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    for (const label of [
      'Was a change needed?',
      'Should this Workflow handle this issue?',
    ]) {
      await choose(canvas, label, 'Yes');
    }
    await userEvent.click(await canvas.findByRole('checkbox'));
    await userEvent.click(canvas.getByRole('button', { name: 'Save review' }));
    await userEvent.click(
      await canvas.findByRole('button', { name: 'Retry saving review' }),
    );
    await expect(
      await canvas.findByRole('heading', {
        name: 'Review saved',
      }),
    ).toBeVisible();
    const writes = requests.filter((r) => r.path.endsWith('/review'));
    await expect(writes).toHaveLength(2);
    await expect(writes[0]!.body).toEqual(writes[1]!.body);
  },
};

export const LongEvidence: Story = { args: { state: 'long_evidence' } };

export const EvidenceSelection: Story = {
  args: { state: 'long_evidence' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('button', {
      name: 'View all 45 evidence records',
    });
    await expect(canvas.getAllByRole('checkbox')).toHaveLength(3);
    await userEvent.click(canvas.getAllByRole('checkbox')[0]!);
    for (const label of [
      'Was a change needed?',
      'Should this Workflow handle this issue?',
    ]) {
      await choose(canvas, label, 'Yes');
    }
    const trigger = canvas.getByRole('button', {
      name: 'View all 45 evidence records',
    });
    await userEvent.click(trigger);
    await expect(
      canvas.getByRole('heading', { name: 'Supporting evidence' }),
    ).toBeVisible();
    await expect(canvas.getAllByRole('checkbox')).toHaveLength(20);
    await userEvent.click(canvas.getByRole('button', { name: 'Next' }));
    await userEvent.click(canvas.getAllByRole('checkbox')[0]!);
    await choose(canvas, 'Selection', 'Selected');
    await expect(canvas.getAllByRole('checkbox')).toHaveLength(2);
    for (const checkbox of canvas.getAllByRole('checkbox'))
      await expect(checkbox).toBeChecked();
    await userEvent.click(
      canvas.getByRole('button', { name: 'Back to issue' }),
    );
    await expect(trigger).toHaveFocus();
    await expect(canvas.getByText('2 evidence records selected')).toBeVisible();
    await expect(canvas.getAllByRole('checkbox')[0]!).toBeChecked();
    await userEvent.click(canvas.getByRole('button', { name: 'Save review' }));
    await expect(
      await canvas.findByRole('heading', {
        name: 'Review saved',
      }),
    ).toBeVisible();
    await expect(
      requests.find((r) => r.path.endsWith('/review'))?.body.evidenceRefs,
    ).toHaveLength(2);
  },
};
