import type { WorkflowDraftContent } from '@luma/api-contract';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { type ReactNode, useState } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';

import { StoryShell } from '../../identity/storybook-shell';
import { WorkflowBuilder } from './builder';
import { GenerationAssistant } from './describe';
import { DraftEditor } from './editor';
import { type GallerySearch, NewWorkflowView } from './gallery';
import {
  content,
  draft,
  organizationId,
  templates,
  validation,
  vocabulary,
} from './storybook-fixtures';

type State =
  | 'gallery'
  | 'loading'
  | 'empty'
  | 'error'
  | 'member'
  | 'builder'
  | 'saves'
  | 'conflict'
  | 'assistant';

function Routed({ children }: { children: ReactNode }) {
  const [client] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  );
  const [router] = useState(() =>
    createRouter({
      history: createMemoryHistory(),
      routeTree: createRootRoute({
        component: () => (
          <QueryClientProvider client={client}>
            <StoryShell page="workflows">{children}</StoryShell>
          </QueryClientProvider>
        ),
      }),
    }),
  );

  return <RouterProvider router={router} />;
}

function Gallery({ state }: { state: State }) {
  const [search, setSearch] = useState<GallerySearch>({});

  return (
    <NewWorkflowView
      organizationId={organizationId}
      templates={
        ['loading', 'error'].includes(state)
          ? undefined
          : state === 'empty'
            ? []
            : templates
      }
      loading={state === 'loading'}
      error={
        state === 'error' ? 'Check your connection, then retry.' : undefined
      }
      retry={() => undefined}
      canManage={state !== 'member'}
      search={search}
      changeSearch={setSearch}
      customize={() => undefined}
      scratch={() => undefined}
      refresh={() => undefined}
    />
  );
}

function Builder() {
  const [value, setValue] = useState<WorkflowDraftContent>(content);

  return (
    <div className="workflows-page authoring-page">
      <WorkflowBuilder
        content={value}
        validation={value === content ? validation : undefined}
        vocabulary={vocabulary}
        readOnly={false}
        onChange={setValue}
        openCode={() => undefined}
      />
      <output aria-label="Step order">
        {value.steps.map((step) => step.id).join(',')}
      </output>
    </div>
  );
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const proposal = {
  id: '77777777-7777-4777-8777-777777777777',
  outcome: 'valid',
  attempts: 1,
  usage: { inputTokens: 1200, outputTokens: 300, costUsd: null },
  route: { profile: 'authoring', adapter: 'bedrock-eu', model: 'eu.model' },
  explanations: [],
  assumptions: ['One hour is long enough for the supplier to respond.'],
  questions: [],
  diagnostics: [],
  draftId: draft.id,
  baseRevision: draft.revision,
  resultingRevision: null,
  state: 'open',
  decidedBy: null,
  decidedAt: null,
  content,
  changes: [
    {
      change: 'added',
      stepId: 'pause',
      field: null,
      before: null,
      after: { id: 'pause', kind: 'wait', seconds: 3600 },
      summary: 'Added “Wait 1 hour” before finishing.',
    },
    {
      change: 'changed',
      stepId: 'finish',
      field: null,
      before: { id: 'finish', kind: 'end', outcome: 'Reorder needed' },
      after: { id: 'finish', kind: 'end', outcome: 'Reorder confirmed' },
      summary: 'Changed the outcome to “Reorder confirmed”.',
    },
  ],
  createdBy: draft.authorId,
  createdAt: '2026-09-28T08:12:00.000Z',
};

/** Answers draft validation and saves in memory; `conflict` rejects every save. */
function mockAuthoring(state: State) {
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : null;
    const url = new URL(
      request ? request.url : String(input),
      'http://localhost',
    );
    const method = init?.method ?? request?.method ?? 'GET';
    if (url.pathname.endsWith('/workflow-authoring/validate'))
      return json(validation);
    if (url.pathname.endsWith('/workflow-authoring/generation'))
      return json({ available: true, reason: null });
    if (url.pathname.endsWith(`/workflow-drafts/${draft.id}/proposals`))
      return json(proposal);
    if (
      url.pathname.includes('/proposals/') &&
      url.pathname.endsWith('/reject')
    )
      return json({ proposal: { ...proposal, state: 'rejected' } });
    if (
      url.pathname.endsWith(`/workflow-drafts/${draft.id}`) &&
      method === 'PUT'
    ) {
      if (state === 'conflict')
        return json(
          {
            code: 'CONFLICT',
            message:
              'Someone else saved this draft. Reload it to see their changes before editing.',
            requestId: 'story',
          },
          409,
        );
      const body = JSON.parse(String(init?.body ?? (await request?.text())));

      return json({
        ...draft,
        revision: body.revision + 1,
        mode: body.mode,
        content: body.content,
        codeView: body.codeView ?? null,
      });
    }

    return json(
      { code: 'NOT_FOUND', message: 'Not found', requestId: 'story' },
      404,
    );
  };

  return () => {
    globalThis.fetch = original;
  };
}

function Preview({ state }: { state: State }) {
  return (
    <Routed>
      {state === 'builder' ? (
        <Builder />
      ) : state === 'saves' || state === 'conflict' || state === 'assistant' ? (
        <div className="workflows-page authoring-page">
          <DraftEditor
            organizationId={organizationId}
            draft={draft}
            vocabulary={vocabulary}
            canManage
            view="build"
            setView={() => undefined}
            reload={() => undefined}
            {...(state === 'assistant'
              ? {
                  assistant: (props) => <GenerationAssistant {...props} />,
                }
              : {})}
          />
        </div>
      ) : (
        <Gallery state={state} />
      )}
    </Routed>
  );
}

const meta = {
  title: 'Workflows/Authoring',
  component: Preview,
  parameters: { layout: 'fullscreen' },
  args: { state: 'gallery' },
  beforeEach: ({ args }) => mockAuthoring(args.state),
} satisfies Meta<typeof Preview>;

export default meta;

type Story = StoryObj<typeof meta>;

export const TemplateGallery: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const body = within(canvasElement.ownerDocument.body);
    await expect(
      await canvas.findByRole('heading', { name: 'Replenish low stock' }),
    ).toBeVisible();
    await expect(canvas.getByText('Needs setup')).toBeVisible();
    await expect(
      canvas.getByRole('link', { name: 'Add a supplier' }),
    ).toBeVisible();
    await userEvent.click(canvas.getByRole('tab', { name: /Resolution/ }));
    await expect(
      canvas.queryByRole('heading', { name: 'Replenish low stock' }),
    ).not.toBeInTheDocument();
    await userEvent.click(canvas.getByRole('tab', { name: /All/ }));
    await userEvent.type(
      canvas.getByLabelText('Search templates'),
      'nothing like this',
    );
    await expect(
      canvas.getByRole('heading', { name: 'No matching templates' }),
    ).toBeVisible();
    await userEvent.click(
      canvas.getByRole('button', { name: 'Clear filters' }),
    );
    const [use] = canvas.getAllByRole('button', { name: 'Use template' });
    await userEvent.click(use!);
    await expect(
      await body.findByRole('dialog', { name: 'Use “Replenish low stock”' }),
    ).toBeVisible();
    await expect(body.getByRole('button', { name: 'Continue' })).toBeDisabled();
    await userEvent.click(body.getByRole('button', { name: 'Cancel' }));
  },
};

export const Loading: Story = { args: { state: 'loading' } };

export const NoTemplates: Story = { args: { state: 'empty' } };

export const Unavailable: Story = { args: { state: 'error' } };

export const MemberCanBrowse: Story = {
  args: { state: 'member' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    for (const button of await canvas.findAllByRole('button', {
      name: 'Use template',
    }))
      await expect(button).toBeDisabled();
    await expect(
      canvas.getByRole('button', { name: 'Build a workflow' }),
    ).toBeDisabled();
  },
};

export const StepBuilder: Story = {
  args: { state: 'builder' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const body = within(canvasElement.ownerDocument.body);
    const order = canvas.getByLabelText('Step order');
    await expect(
      canvas.getByText('Choose a category people will recognise.'),
    ).toBeVisible();
    await expect(
      within(canvas.getByRole('list', { name: 'Workflow steps' })).getByText(
        'Can’t run here',
      ),
    ).toBeVisible();
    // Keyboard reordering through the drag handle. The sensor listens for moves from the next
    // tick, and may scroll the list before the step moves, as with a real keyboard.
    canvas.getByRole('button', { name: 'Reorder step 1' }).focus();
    await userEvent.keyboard('{Enter}');
    await body.findByText(/Code step is now at position 1 of 3/);
    await userEvent.keyboard('{ArrowDown}');
    await body.findByText(/Code step is now at position 2 of 3/);
    await userEvent.keyboard('{Enter}');
    await waitFor(() =>
      expect(order).toHaveTextContent('needs-order,compute,finish'),
    );
    // The step menu moves steps too, and focus stays on the moved step.
    await userEvent.click(
      canvas.getByRole('button', { name: 'Actions for step 2' }),
    );
    await userEvent.click(
      await body.findByRole('menuitem', { name: 'Move up' }),
    );
    await expect(order).toHaveTextContent('compute,needs-order,finish');
    // Choosing an insert point, then a palette step, adds it there.
    await userEvent.click(
      canvas.getByRole('button', { name: 'Add a step after step 2' }),
    );
    await expect(canvas.getByText('after step 2')).toBeVisible();
    await userEvent.click(
      canvas.getByRole('button', { name: 'Add step: Wait' }),
    );
    await expect(order).toHaveTextContent('compute,needs-order,wait,finish');
    // Without a chosen point, new steps go before the final step.
    await userEvent.type(canvas.getByLabelText('Search steps'), 'current');
    await userEvent.click(
      canvas.getByRole('button', { name: 'Add step: Current stock' }),
    );
    await expect(order).toHaveTextContent(
      'compute,needs-order,wait,read,finish',
    );
  },
};

export const StepBuilderNarrow: Story = {
  args: { state: 'builder' },
  globals: { viewport: { value: 'mobile1', isRotated: false } },
};

export const AutosaveSaved: Story = {
  args: { state: 'saves' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const name = await canvas.findByLabelText('Name');
    await userEvent.type(name, ' now');
    await waitFor(
      () => expect(canvas.getByText('All changes saved')).toBeVisible(),
      { timeout: 4000 },
    );
    await userEvent.click(canvas.getByRole('button', { name: 'Undo' }));
    await expect(name).toHaveValue('Check restock need now'.slice(0, -1));
  },
};

export const SaveConflict: Story = {
  args: { state: 'conflict' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(await canvas.findByLabelText('Name'), '!');
    await expect(
      await canvas.findByText(
        /Someone else saved this draft while you were editing/,
        {},
        { timeout: 4000 },
      ),
    ).toBeVisible();
    await expect(
      canvas.getByRole('button', { name: 'Reload latest' }),
    ).toBeVisible();
    await expect(canvas.getByLabelText('Name')).toBeDisabled();
  },
};

export const ProposedChange: Story = {
  args: { state: 'assistant' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(
      await canvas.findByLabelText('What should change?'),
      'Wait an hour before finishing.',
    );
    await userEvent.click(
      canvas.getByRole('button', { name: 'Propose change' }),
    );
    const proposal = await canvas.findByLabelText('Proposed change');
    await expect(within(proposal).getByText('Added')).toBeVisible();
    await expect(
      within(proposal).getByText('Changed the outcome to “Reorder confirmed”.'),
    ).toBeVisible();
    await expect(canvas.getByLabelText('Name')).toHaveValue(
      'Check restock need',
    );
    await userEvent.click(
      within(proposal).getByRole('button', { name: 'Reject' }),
    );
    await expect(
      await canvas.findByLabelText('What should change?'),
    ).toBeVisible();
  },
};

export const Dark: Story = { globals: { theme: 'dark' } };
