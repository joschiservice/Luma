import type { AssistantAnswer } from '@luma/api-contract';
import { Button } from '@luma/ui/components/primitives/button';
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

import { askLuma } from '../../lib/assistant-panel';
import { StoryShell } from '../../shell/storybook-shell';
import { AssistantPanel } from './panel';

type State = 'available' | 'unavailable' | 'failed';

const organizationId = '6c9ab5cd-6990-4259-af41-d9551e7c14fd';
const orders = [
  ['10000000-0000-4000-8000-000000000001', '#1042', '84.90', 'unfulfilled'],
  ['10000000-0000-4000-8000-000000000002', '#1047', '129.00', 'partial'],
  ['10000000-0000-4000-8000-000000000003', '#1051', '42.50', 'unfulfilled'],
] as const;

const answer: AssistantAnswer = {
  id: '20000000-0000-4000-8000-000000000001',
  content: `**3 orders** placed last week are still not fully fulfilled:\n\n${orders
    .map(
      ([id, number, total, state]) =>
        `- ${number} · ${total} EUR · ${state === 'partial' ? 'partly shipped' : 'nothing shipped yet'} [[order:${id}]]`,
    )
    .join(
      '\n',
    )}\n\nNone is overdue yet. The issue on #1047 is waiting for an approval [[issue:30000000-0000-4000-8000-000000000001]].`,
  citations: [
    ...orders.map(([id, number, , state]) => ({
      kind: 'order' as const,
      id,
      label: `Order ${number}`,
      detail: `Open · ${state === 'partial' ? 'Partial' : 'Unfulfilled'}`,
      sources: [{ label: 'Shopify · Northstar', system: 'shopify' }],
      observedAt: '2026-10-05T09:12:00.000Z',
      sourceUpdatedAt: '2026-10-05T09:10:00.000Z',
    })),
    {
      kind: 'issue',
      id: '30000000-0000-4000-8000-000000000001',
      label: 'Fulfillment delay',
      detail: 'Fulfillment for #1047 has not progressed for 52 hours.',
      sources: [{ label: 'Shopify · Northstar', system: null }],
      observedAt: '2026-10-04T16:40:00.000Z',
      sourceUpdatedAt: null,
    },
  ],
  steps: [
    {
      tool: 'search_orders',
      summary:
        'Searched orders · Outstanding · placed 2026-09-28 to 2026-10-05',
      outcome: 'ok',
      records: 3,
    },
    {
      tool: 'get_order',
      summary: 'Read order details',
      outcome: 'ok',
      records: 2,
    },
  ],
  outcome: 'answered',
  asOf: '2026-10-05T09:12:30.000Z',
  usage: { modelCalls: 3, toolCalls: 2, inputTokens: 5200, outputTokens: 340 },
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Answers availability and questions for the selected state. */
function mockAssistant(state: State) {
  const original = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(
      input instanceof Request ? input.url : String(input),
      'http://localhost',
    );
    if (url.pathname.endsWith('/assistant'))
      return json({
        available: state !== 'unavailable',
        reason:
          state === 'unavailable'
            ? 'Asking Luma needs an EU model route with zero data retention. Whoever runs this Luma server needs to configure the assistant route.'
            : null,
        reads: ['order', 'issue', 'stock_position', 'fulfillment', 'return'],
      });
    if (url.pathname.endsWith('/assistant/answers')) {
      await new Promise((resolve) => setTimeout(resolve, 300));

      return state === 'failed'
        ? json(
            {
              code: 'SERVICE_UNAVAILABLE',
              message: 'The model is busy. Try again in a minute.',
              requestId: 'story',
            },
            503,
          )
        : json(answer);
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

/** The shell with the panel open; `state` selects the mocked server responses. */
function Preview({
  state,
  contextual = false,
}: {
  state: State;
  contextual?: boolean;
}) {
  const [client] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  );
  const [router] = useState(() =>
    createRouter({
      history: createMemoryHistory(),
      routeTree: createRootRoute({
        component: () => (
          <QueryClientProvider client={client}>
            <StoryShell
              key={state}
              page="Orders"
              children={
                contextual ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      askLuma('What happened and what can I review next?', {
                        context: {
                          record: { kind: 'order', id: orders[1][0] },
                        },
                        label: 'Order #1047',
                      })
                    }
                  >
                    Explain with Luma
                  </Button>
                ) : undefined
              }
              assistant={
                <AssistantPanel organizationId={organizationId} open />
              }
            />
          </QueryClientProvider>
        ),
      }),
    }),
  );

  return <RouterProvider router={router} />;
}

const meta = {
  title: 'Assistant/Panel',
  component: Preview,
  parameters: { layout: 'fullscreen' },
  args: { state: 'available' },
  beforeEach: ({ args }) => mockAssistant(args.state),
} satisfies Meta<typeof Preview>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Suggestions: Story = {
  play: async ({ canvasElement }) => {
    const panel = within(canvasElement);
    await expect(
      await panel.findByRole('heading', { name: 'Ask about your operations' }),
    ).toBeVisible();
    await expect(
      panel.getByRole('button', {
        name: 'Which orders from last week are still unfulfilled?',
      }),
    ).toBeVisible();
  },
};

export const Answered: Story = {
  play: async ({ canvasElement }) => {
    const panel = within(canvasElement);
    await userEvent.click(
      await panel.findByRole('button', {
        name: 'Which orders from last week are still unfulfilled?',
      }),
    );
    const sources = await panel.findByRole('region', { name: 'Sources' });
    await expect(
      within(sources).getByRole('link', { name: /Order #1042/ }),
    ).toBeVisible();
    await expect(
      panel.getByRole('link', { name: 'Source 4: Issue · Fulfillment delay' }),
    ).toBeVisible();
    await userEvent.click(panel.getByText('2 reads · 5 records'));
    await expect(
      panel.getByText(/Searched orders · Outstanding/),
    ).toBeVisible();
  },
};

export const Unavailable: Story = {
  args: { state: 'unavailable' },
  play: async ({ canvasElement }) => {
    const panel = within(canvasElement);
    await expect(
      await panel.findByText(/configure the assistant route/),
    ).toBeVisible();
    await expect(panel.getByLabelText('Question for Luma')).toBeDisabled();
  },
};

export const Failed: Story = {
  args: { state: 'failed' },
  play: async ({ canvasElement }) => {
    const panel = within(canvasElement);
    const input = await panel.findByLabelText('Question for Luma');
    await expect(input).toBeEnabled();
    await userEvent.type(input, 'Any late shipments?{Enter}');
    await expect(await panel.findByRole('alert')).toHaveTextContent(
      'The model is busy. Try again in a minute.',
    );
    await expect(
      panel.getByRole('button', { name: 'Try again' }),
    ).toBeVisible();
  },
};

export const Dark: Story = {
  ...Answered,
  globals: { theme: 'dark' },
};

export const Mobile: Story = {
  ...Answered,
  globals: { viewport: { value: 'mobile1', isRotated: false } },
};

export const ContextualRecord: Story = {
  args: { contextual: true },
  play: async ({ canvasElement }) => {
    const panel = within(canvasElement);
    await userEvent.click(
      panel.getByRole('button', { name: 'Explain with Luma' }),
    );
    await expect(panel.getByText('Investigating: Order #1047')).toBeVisible();
    await userEvent.click(panel.getByRole('button', { name: 'Ask' }));
    await expect(
      await panel.findByRole('heading', { name: 'Sources' }),
    ).toBeVisible();
  },
};
