import { Button } from '@luma/ui/components/primitives/button';
import { WorkspaceTimezone } from '@luma/ui/components/primitives/workspace-date';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { type ReactNode, useState } from 'react';
import { expect, within } from 'storybook/test';

import appStyles from '../../styles.css?inline';
import type { NeedsYouSearch } from '../decisions/data';
import { DecisionInspector } from '../decisions/inspector';
import { NeedsYouView } from '../decisions/page';
import { HomePage } from '../home/page';
import { homeSearch } from '../home/preferences';
import { sessionKey } from '../identity/data';
import { StoryShell } from '../identity/storybook-shell';
import { OrderDetailView } from '../orders/detail';
import {
  activeCases,
  activity,
  decisionList,
  members,
  openDecisionId,
  orderDetail,
  organizationId,
  overview,
  self,
  timeZone,
} from './fixtures';

/*
 * Screens for the Auren website, rendered from the product's own pages with hand-made data.
 * `pnpm screenshots:marketing` captures them in English and German; see the design workflow
 * guide. Keep them looking like a real, busy workspace when the pages change.
 */

const waiting = 5;

/** Answers the API requests Home makes; anything else fails like an unavailable service. */
function mockHomeApi() {
  const original = globalThis.fetch;
  const routes: [suffix: string, body: () => unknown][] = [
    ['/operations/overview', overview],
    ['/decisions', decisionList],
    ['/exceptions', activeCases],
    ['/activity', activity],
    // The default layout, so Customize is available as it is in the product.
    ['/layout', () => ({ home: null, pinned: [], revision: 0 })],
  ];
  globalThis.fetch = async (input, init) => {
    const url = new URL(
      input instanceof Request ? input.url : String(input),
      location.origin,
    );
    if (!url.pathname.startsWith('/api/')) return original(input, init);
    const route = routes.find(([suffix]) => url.pathname.endsWith(suffix));
    if (route) return Response.json(route[1]());

    return Response.json(
      {
        code: 'SERVICE_UNAVAILABLE',
        message: 'Preview response',
        requestId: 'storybook',
      },
      { status: 503 },
    );
  };

  return () => {
    globalThis.fetch = original;
  };
}

/** The real Home route, inside the workspace frame, reading through the mocked API. */
function HomeScreen() {
  const [client] = useState(() => {
    const value = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    value.setQueryData(sessionKey, {
      sessionId: 'storybook',
      user: {
        id: self,
        name: 'Alex Morgan',
        email: 'alex@northstar.example',
        twoFactorEnabled: true,
      },
    });

    return value;
  });
  const [router] = useState(() => {
    const root = createRootRoute({ component: Outlet });
    const app = createRoute({ getParentRoute: () => root, path: 'app' });
    const workspace = createRoute({
      getParentRoute: () => app,
      path: '$organizationId',
    });
    const home = createRoute({
      getParentRoute: () => workspace,
      path: 'home',
      validateSearch: homeSearch,
      component: () => (
        <StoryShell page="home" attention={waiting}>
          <HomePage />
        </StoryShell>
      ),
    });

    return createRouter({
      routeTree: root.addChildren([
        app.addChildren([workspace.addChildren([home])]),
      ]),
      history: createMemoryHistory({
        initialEntries: [`/app/${organizationId}/home`],
      }),
      context: { queryClient: client },
    });
  });

  return (
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}

function NeedsYouScreen() {
  const [search, setSearch] = useState<NeedsYouSearch>({
    item: openDecisionId,
  });
  const [list] = useState(decisionList);
  const item = list.items.find((entry) => entry.id === search.item);
  const [now] = useState(() => Date.now());

  return (
    <StoryShell page="needs-you" attention={waiting}>
      <NeedsYouView
        organizationId={organizationId}
        search={search}
        list={list}
        loading={false}
        offline={false}
        live="live"
        onNext={() => {}}
        onChange={setSearch}
        onRefresh={() => {}}
        now={now}
        members={members}
        self={self}
        selected={item}
        inspector={
          item ? (
            <DecisionInspector
              organizationId={organizationId}
              item={item}
              members={members}
              self={self}
              assignmentAccess="anyone"
              now={now}
              onClose={() => setSearch({ ...search, item: undefined })}
              onAssign={() => {}}
              review={
                <div className="replenishment-review">
                  <Button variant="outline">Reject</Button>{' '}
                  <Button>Approve</Button>
                </div>
              }
            />
          ) : null
        }
      />
    </StoryShell>
  );
}

function OrderScreen() {
  const [detail] = useState(orderDetail);

  return (
    <StoryShell page="orders" attention={waiting}>
      <OrderDetailView
        organizationId={organizationId}
        search={{ view: 'needs_you' }}
        refresh={() => {}}
        loading={false}
        offline={false}
        detail={detail}
        sourceContext={() => null}
      />
    </StoryShell>
  );
}

/** Pages that don't route on their own get an in-memory router and the app stylesheet. */
function Routed({ children }: { children: () => ReactNode }) {
  const [router] = useState(() =>
    createRouter({
      history: createMemoryHistory(),
      routeTree: createRootRoute({
        component: () => (
          <>
            <style>{appStyles}</style>
            {children()}
          </>
        ),
      }),
    }),
  );

  return <RouterProvider router={router} />;
}

const screens = {
  home: HomeScreen,
  'needs-you': NeedsYouScreen,
  order: OrderScreen,
};

function Screen({ screen }: { screen: keyof typeof screens }) {
  const Component = screens[screen];

  return (
    <WorkspaceTimezone.Provider value={timeZone}>
      {screen === 'home' ? (
        <Component />
      ) : (
        <Routed>{() => <Component />}</Routed>
      )}
    </WorkspaceTimezone.Provider>
  );
}

const meta = {
  title: 'Marketing/Screenshots',
  component: Screen,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof Screen>;

export default meta;

type Story = StoryObj<typeof meta>;

/** Home in dark mode: what needs you, what Luma is handling, connections and activity. */
export const Home: Story = {
  args: { screen: 'home' },
  globals: { theme: 'dark' },
  beforeEach: mockHomeApi,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByText('Release fulfillment hold on order #48213'),
    ).toBeVisible();
    await expect(
      await canvas.findByText('Stock for LS-SAND-M matches JTL-Wawi again'),
    ).toBeVisible();
  },
};

/** Needs you in light mode, with the hold release open beside the queue. */
export const NeedsYou: Story = {
  args: { screen: 'needs-you' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole('heading', {
        name: 'Release fulfillment hold on order #48213',
      }),
    ).toBeVisible();
  },
};

/** Order 48213 in dark mode, compared across Shopify and JTL-Wawi with its issue and run. */
export const OrderRecord: Story = {
  args: { screen: 'order' },
  globals: { theme: 'dark' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole('heading', { name: '#48213', level: 1 }),
    ).toBeVisible();
  },
};
