import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import { expect, it } from 'vitest';

import {
  alex,
  inboxNow,
  inboxOrg,
  threadDetailFixture,
  threadFixtures,
} from './fixtures';
import { ThreadRow } from './page';
import { memberName } from './people';
import { RecordThreadList } from './record-messages';
import { threadAccess, ThreadDetailView } from './thread';

async function render(node: ReactNode) {
  const router = createRouter({
    history: createMemoryHistory(),
    routeTree: createRootRoute({ component: () => node }),
  });
  await router.load();

  return renderToString(
    <QueryClientProvider client={new QueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

const members = [{ userId: alex, name: 'Alex Morgan' }];
const people = {
  members,
  self: alex,
  name: (id: string) => memberName(id, members, alex),
};

it('shows reply state, owner, links and review counts in a thread row', async () => {
  const html = await render(
    <ThreadRow
      thread={threadFixtures[0]!}
      organizationId={inboxOrg}
      members={members}
      self={alex}
      now={inboxNow}
      showMailbox={false}
    />,
  );
  expect(html).toContain('Northstar Supply');
  expect(html).toContain('Reply overdue');
  expect(html).toContain('Awaiting reply');
  expect(html).toContain('Owner: You');
  expect(html).toContain('PO-2026-0412');
  expect(html).toContain('3 facts to review');
});

it('labels notes as internal and explains why a reply needs approval', async () => {
  const html = await render(
    <ThreadDetailView
      organizationId={inboxOrg}
      detail={threadDetailFixture}
      access={{ manage: true, send: true, approve: true }}
      people={people}
      now={inboxNow}
      onClose={() => undefined}
    />,
  );
  expect(html).toContain('Internal — never sent');
  expect(html).toContain(
    'Needs approval from someone else because it confirms a date and it confirms a quantity.',
  );
  expect(html).toContain('Request approval');
  expect(html).toContain('Older than a day');
  expect(html).toContain('The text was removed on');
  expect(html).toContain('Confirm link');
});

it('hides work controls from people who can only read', async () => {
  const html = await render(
    <ThreadDetailView
      organizationId={inboxOrg}
      detail={threadDetailFixture}
      access={threadAccess(threadDetailFixture, () => false)}
      people={people}
      now={inboxNow}
      onClose={() => undefined}
    />,
  );
  expect(html).not.toContain('Request approval');
  expect(html).not.toContain('Add note');
  expect(html).not.toContain('Link record');
  expect(html).toContain('Review the text before sending.');
});

it('lists record threads with an empty state', async () => {
  expect(
    await render(<RecordThreadList organizationId={inboxOrg} threads={[]} />),
  ).toContain('No message threads are linked to this record.');
  const html = await render(
    <RecordThreadList organizationId={inboxOrg} threads={threadFixtures} />,
  );
  expect(html).toContain('Where is my order #48213?');
  expect(html).toContain('thread=bbbbbbbb-0000-4000-8000-000000000002');
});
