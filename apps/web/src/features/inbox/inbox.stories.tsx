import type { DocumentDetail, Mailbox, ThreadDetail } from '@luma/api-contract';
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

import { groupId } from '../../kit/collections/groups';
import { contextFixture } from '../../kit/identity/context.fixture';
import { contextOptions } from '../../kit/identity/data';
import { membersOptions } from '../../kit/settings/data';
import appStyles from '../../styles.css?inline';
import type { InboxSearch } from './data';
import { DocumentReviewView } from './document';
import {
  alex,
  documentFixture,
  inboxNow,
  inboxOrg,
  mailboxFixture,
  outboundFixtures,
  sam,
  sheetDocumentFixture,
  threadDetailFixture,
  threadFixtures,
} from './fixtures';
import { InboxView } from './page';
import { memberName } from './people';
import { MailboxSettingsView } from './settings';
import { ThreadDetailView } from './thread';

const members = [
  { userId: alex, name: 'Alex Morgan', email: 'alex@lumashop.example' },
  { userId: sam, name: 'Sam Rivera', email: 'sam@lumashop.example' },
];
const people = {
  members,
  self: alex,
  name: (id: string) => memberName(id, members, alex),
};

type Screen =
  | {
      kind: 'inbox';
      search: InboxSearch;
      state?: 'ready' | 'loading' | 'error' | 'empty' | 'none';
      detail?: ThreadDetail;
      /** Groups the threads by owner, as the list API's groups would. */
      grouped?: boolean;
    }
  | { kind: 'settings'; mailboxes: Mailbox[] | undefined; manage: boolean }
  | { kind: 'document'; detail: DocumentDetail };

function Content({ screen }: { screen: Screen }) {
  const [search, setSearch] = useState(
    screen.kind === 'inbox' ? screen.search : {},
  );
  if (screen.kind === 'settings')
    return (
      <MailboxSettingsView
        organizationId={inboxOrg}
        mailboxes={screen.mailboxes}
        manage={screen.manage}
        refresh={() => undefined}
      />
    );
  if (screen.kind === 'document')
    return (
      <DocumentReviewView
        organizationId={inboxOrg}
        detail={screen.detail}
        manage
        refresh={() => undefined}
        name={people.name}
      />
    );
  const state = screen.state ?? 'ready';

  return (
    <div style={{ height: '100vh' }}>
      <InboxView
        organizationId={inboxOrg}
        search={search}
        threads={
          state === 'ready'
            ? threadFixtures
            : state === 'empty' || state === 'none'
              ? []
              : undefined
        }
        counts={
          state === 'ready'
            ? { open: 2, mine: 1, unassigned: 1, overdue: 1, review: 1 }
            : undefined
        }
        mailboxes={state === 'none' ? [] : [mailboxFixture]}
        loading={state === 'loading'}
        error={
          state === 'error'
            ? 'The inbox is temporarily unavailable. Try again in a moment.'
            : undefined
        }
        onChange={setSearch}
        onRefresh={() => undefined}
        now={inboxNow}
        members={members}
        self={alex}
        grouped={
          screen.grouped && state === 'ready'
            ? {
                grouping: { field: 'owner', showEmpty: false },
                groups: [
                  ...new Set(threadFixtures.map((thread) => thread.ownerId)),
                ].map((owner) => {
                  const rows = threadFixtures.filter(
                    (thread) => thread.ownerId === owner,
                  );

                  return {
                    id: groupId(owner),
                    group: {
                      key: owner,
                      count: rows.length,
                      complete: true,
                      itemIds: rows.map((thread) => thread.id),
                      nextCursor: null,
                      sums: [],
                    },
                    rows,
                    more: undefined,
                  };
                }),
                label: (key) =>
                  typeof key === 'string' ? people.name(key) : 'Unassigned',
                collapsed: [],
                onCollapsedChange: () => undefined,
              }
            : undefined
        }
        detail={
          search.thread ? (
            <ThreadDetailView
              organizationId={inboxOrg}
              detail={screen.detail ?? threadDetailFixture}
              access={{ manage: true, send: true, approve: true }}
              people={people}
              now={inboxNow}
              onClose={() => setSearch({ ...search, thread: undefined })}
            />
          ) : null
        }
      />
    </div>
  );
}

function Preview({ screen }: { screen: Screen }) {
  const [client] = useState(() => {
    const value = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    value.setQueryData(
      contextOptions(inboxOrg).queryKey,
      contextFixture(inboxOrg, {
        name: 'Operations',
        permissions: [
          'messages.read',
          'messages.manage',
          'messages.send',
          'decisions.respond',
          'orders.read',
          'customers.read',
          'procurement.read',
          'issues.read',
        ],
      }),
    );
    value.setQueryData(membersOptions(inboxOrg).queryKey, []);

    return value;
  });
  const [router] = useState(() =>
    createRouter({
      history: createMemoryHistory(),
      routeTree: createRootRoute({
        component: () => (
          <QueryClientProvider client={client}>
            <style>{appStyles}</style>
            <Content screen={screen} />
          </QueryClientProvider>
        ),
      }),
    }),
  );

  return <RouterProvider router={router} />;
}

const meta = {
  title: 'Inbox/Operations inbox',
  component: Preview,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof Preview>;

export default meta;

type Story = StoryObj<typeof meta>;

export const List: Story = {
  args: { screen: { kind: 'inbox', search: {} } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      (await canvas.findAllByText('Northstar Supply'))[0],
    ).toBeVisible();
    await expect(canvas.getByText('Reply overdue')).toBeVisible();
    await expect(canvas.getAllByText('Awaiting reply')[0]).toBeVisible();
    await expect(canvas.getByText('3 facts to review')).toBeVisible();
  },
};

export const GroupedByOwner: Story = {
  args: { screen: { kind: 'inbox', search: {}, grouped: true } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole('group', { name: 'Threads by Owner' }),
    ).toBeVisible();
  },
};

export const Thread: Story = {
  args: {
    screen: { kind: 'inbox', search: { thread: threadFixtures[0]!.id } },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole('heading', { name: 'Internal notes' }),
    ).toBeVisible();
    await expect(canvas.getByText('Internal — never sent')).toBeVisible();
    await expect(
      canvas.getByText(/Needs approval from someone else because/),
    ).toBeVisible();
    await expect(
      canvas.getByRole('button', { name: 'Request approval' }),
    ).toBeEnabled();
    await expect(
      canvas.getByRole('button', { name: 'Confirm link' }),
    ).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Close panel' }));
    await waitFor(() =>
      expect(
        canvas.queryByRole('heading', { name: 'Internal notes' }),
      ).toBeNull(),
    );
  },
};

export const ThreadApproval: Story = {
  args: {
    screen: {
      kind: 'inbox',
      search: { thread: threadFixtures[0]!.id },
      detail: {
        ...threadDetailFixture,
        outbound: [outboundFixtures.approval],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole('button', { name: 'Approve' }),
    ).toBeEnabled();
    await expect(canvas.getByRole('button', { name: 'Reject' })).toBeEnabled();
  },
};

export const ThreadUncertain: Story = {
  args: {
    screen: {
      kind: 'inbox',
      search: { thread: threadFixtures[0]!.id },
      detail: {
        ...threadDetailFixture,
        outbound: [outboundFixtures.uncertain],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText(/never sends it again/)).toBeVisible();
    await expect(
      canvas.getByRole('button', { name: 'Check the mailbox' }),
    ).toBeEnabled();
  },
};

export const ThreadDark: Story = {
  args: Thread.args!,
  globals: { theme: 'dark' },
};

export const ThreadNarrow: Story = {
  args: Thread.args!,
  globals: { viewport: { value: 'mobile1', isRotated: false } },
};

export const Loading: Story = {
  args: { screen: { kind: 'inbox', search: {}, state: 'loading' } },
};

export const Unavailable: Story = {
  args: { screen: { kind: 'inbox', search: {}, state: 'error' } },
};

export const Empty: Story = {
  args: {
    screen: { kind: 'inbox', search: { view: 'overdue' }, state: 'empty' },
  },
};

export const NoMailbox: Story = {
  args: { screen: { kind: 'inbox', search: {}, state: 'none' } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole('link', { name: 'Connect Gmail in Apps' }),
    ).toBeVisible();
  },
};

export const Mailboxes: Story = {
  args: {
    screen: { kind: 'settings', mailboxes: [mailboxFixture], manage: true },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByText('Supplier: Northstar Supply'),
    ).toBeVisible();
    await expect(canvas.getByText('Reading older messages…')).toBeVisible();
  },
};

export const MailboxesBlocked: Story = {
  args: {
    screen: {
      kind: 'settings',
      manage: false,
      mailboxes: [
        {
          ...mailboxFixture,
          state: 'blocked',
          stateReason: 'Google revoked access. Reconnect the mailbox in Apps.',
          connectionStatus: 'revoked',
          rules: [],
        },
      ],
    },
  },
  globals: { theme: 'dark' },
};

export const DocumentReview: Story = {
  args: { screen: { kind: 'document', detail: documentFixture } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const confirm = await canvas.findAllByRole('button', { name: 'Confirm' });
    // The low-confidence date needs a correction before it can be confirmed.
    await expect(
      confirm.some((button) => button.hasAttribute('disabled')),
    ).toBe(true);
    await userEvent.click(canvas.getByRole('button', { name: /21 Oct 2026/ }));
    await expect(
      canvas.getByRole('button', { name: /21 Oct 2026/ }),
    ).toHaveAttribute('aria-pressed', 'true');
  },
};

export const DocumentReviewNarrow: Story = {
  args: DocumentReview.args!,
  globals: { viewport: { value: 'mobile1', isRotated: false } },
};

export const SheetReview: Story = {
  args: { screen: { kind: 'document', detail: sheetDocumentFixture } },
  globals: { theme: 'dark' },
};

export const DocumentFailed: Story = {
  args: {
    screen: {
      kind: 'document',
      detail: {
        ...documentFixture,
        document: {
          ...documentFixture.document,
          state: 'failed',
          stateReason: 'The reading service timed out.',
        },
        representation: null,
        facts: [],
        removedFacts: [],
      },
    },
  },
};
