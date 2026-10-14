import {
  type ReturnList,
  type ReturnListItem,
  type ReturnStage,
  returnStageSchema,
} from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
import { Alert } from '@luma/ui/components/primitives/alert';
import { CollectionToolbar } from '@luma/ui/components/primitives/collection-toolbar';
import type { DataTableSort } from '@luma/ui/components/primitives/data-table';
import { Pagination } from '@luma/ui/components/primitives/pagination';
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

import { CollectionNotices } from '../../kit/collections/notices';
import type { CollectionError } from '../../kit/collections/paging';
import appStyles from '../../styles.css?inline';
import { returnGroupLabel } from './collection';
import { returnOptions } from './data';
import { ReturnDetailView } from './detail';
import { returnSourceLabel } from './fields';
import { ReturnsEmpty, ReturnsView, StageStrip } from './page';
import { accessMessage, stageLabels } from './presentation';
import { ReturnPreview } from './preview';
import { ReturnResults } from './results';
import {
  detail,
  list,
  noStages,
  returnItem,
  sources,
} from './returns-fixtures';

const org = '99999999-9999-4999-8999-999999999999';

const closed = {
  ...detail,
  item: returnItem({
    status: 'closed',
    stage: 'closed',
    group: 'done',
    received: '2',
    refundedUnits: '2',
    refund: {
      state: 'refunded',
      currency: 'EUR',
      refunded: '48',
      pending: null,
      failedAttempts: 1,
    },
  }),
  timeline: { ...detail.timeline, closedAt: '2026-09-30T07:00:00.000Z' },
  refunds: [
    detail.refunds[0]!,
    {
      ...detail.refunds[1]!,
      transactions: [
        {
          ...detail.refunds[1]!.transactions[0]!,
          status: 'success' as const,
          processedAt: '2026-09-29T10:02:00.000Z',
        },
      ],
    },
  ],
};

const requested = {
  ...detail,
  item: returnItem({
    status: 'requested',
    stage: 'requested',
    group: 'action',
    received: '0',
  }),
  timeline: {
    ...detail.timeline,
    approvedAt: null,
    receivedAt: null,
  },
  lines: detail.lines.map((line) => ({
    ...line,
    received: '0',
    restocked: '0',
    refunded: '0',
  })),
  refunds: [],
};

const stageGroups: ReturnList = {
  ...list,
  groups: [
    {
      key: 'requested',
      count: 1,
      complete: true,
      itemIds: [list.items[0]!.id],
      nextCursor: null,
      sums: [{ field: 'value', currency: 'EUR', amount: '48.00' }],
    },
    {
      key: 'awaiting_items',
      count: 6,
      complete: false,
      itemIds: [list.items[3]!.id],
      nextCursor: 'group-next',
      sums: [{ field: 'value', currency: 'EUR', amount: '288.00' }],
    },
    {
      key: 'awaiting_refund',
      count: 1,
      complete: true,
      itemIds: [list.items[1]!.id],
      nextCursor: null,
      sums: [],
    },
    {
      key: 'refund_pending',
      count: 1,
      complete: true,
      itemIds: [list.items[4]!.id],
      nextCursor: null,
      sums: [],
    },
    {
      key: 'refund_failed',
      count: 1,
      complete: true,
      itemIds: [list.items[2]!.id],
      nextCursor: null,
      sums: [],
    },
  ],
};

/** The Returns list in a fixed state, with the page's real results, preview and notices. */
function ListContent({ state }: { state: string }) {
  const [stage, setStage] = useState<ReturnStage | undefined>();
  const [sort, setSort] = useState<DataTableSort>({
    key: 'requested',
    direction: 'asc',
  });
  const [collapsed, setCollapsed] = useState<string[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [open, setOpen] = useState<string | undefined>(
    state === 'preview' ? detail.item.id : undefined,
  );
  const [client] = useState(() => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(
      returnOptions(org, detail.item.id).queryKey,
      detail,
    );

    return queryClient;
  });
  const grouping =
    state === 'grouped' || state === 'board'
      ? { field: 'stage', showEmpty: false }
      : null;
  const shown: ReturnList =
    state === 'not-shared'
      ? {
          ...list,
          items: [],
          sources: sources.map((source) => ({
            ...source,
            access: 'not_requested' as const,
            records: 0,
          })),
          counts: {
            views: { action: 0, waiting: 0, done: 0, all: 0 },
            stages: noStages,
          },
        }
      : state === 'nothing-pending'
        ? {
            ...list,
            items: [],
            counts: {
              views: { action: 0, waiting: 2, done: 7, all: 9 },
              stages: {
                ...noStages,
                awaiting_items: 1,
                refund_pending: 1,
                closed: 7,
              },
            },
          }
        : state === 'unmatched'
          ? { ...list, items: [] }
          : grouping
            ? stageGroups
            : {
                ...list,
                items: stage
                  ? list.items.filter((item) => item.stage === stage)
                  : list.items,
              };
  const error: CollectionError | undefined =
    state === 'error'
      ? { kind: 'unavailable' }
      : state === 'repair'
        ? { kind: 'invalid', message: m.collections_needs_repair() }
        : undefined;
  const hidden = ['loading', 'error', 'repair'].includes(state);
  const link = (item: ReturnListItem) => (
    <a
      href={`#return-${item.id}`}
      onClick={(event) => {
        if (state !== 'preview') return;
        event.preventDefault();
        setOpen(item.id);
      }}
    />
  );
  const openReturn = list.items.find((item) => item.id === open);
  const view = state === 'nothing-pending' ? 'action' : 'all';

  return (
    <QueryClientProvider client={client}>
      <ReturnsView
        stages={
          hidden ? null : (
            <StageStrip list={shown} selected={stage} choose={setStage} />
          )
        }
        toolbar={
          <CollectionToolbar
            search={{
              value: state === 'unmatched' ? 'nothing' : undefined,
              onChange: () => {},
              label: m.returns_list_search_label(),
              placeholder: m.returns_list_search_placeholder(),
            }}
            filters={[
              {
                kind: 'multi-choice',
                key: 'stage',
                label: m.returns_column_stage(),
                value: stage ? [stage] : undefined,
                options: returnStageSchema.options.map((value) => ({
                  value,
                  label: stageLabels[value],
                })),
                onChange: (values) =>
                  setStage(
                    returnStageSchema.options.find(
                      (value) => value === values?.[0],
                    ),
                  ),
              },
            ]}
            sort={{
              value: sort.key,
              options: [
                { value: 'requested', label: m.returns_column_requested() },
                { value: 'activity', label: m.returns_column_activity() },
              ],
              onChange: (key) => setSort({ ...sort, key }),
              direction: sort.direction,
              onDirectionChange: (direction) => setSort({ ...sort, direction }),
            }}
            onRefresh={() => {}}
          />
        }
        notices={
          <>
            {shown.sources
              .filter((source) => source.access !== 'granted')
              .map((source) => (
                <Alert key={source.connectionId} tone="info">
                  <p>{accessMessage(source)}</p>
                </Alert>
              ))}
            <CollectionNotices
              offline={state === 'offline'}
              error={error}
              hasRows={!hidden}
              retry={() => {}}
              firstPage={() => {}}
              repair={state === 'repair' ? () => {} : undefined}
            />
          </>
        }
        loading={state === 'loading'}
        results={
          hidden ? undefined : (
            <ReturnResults
              list={shown}
              layout={
                state === 'rows'
                  ? 'list'
                  : state === 'board'
                    ? 'board'
                    : 'table'
              }
              density="comfortable"
              grouping={grouping}
              caption="Returns and refunds: All. Sorted by: Requested"
              link={link}
              empty={
                <ReturnsEmpty
                  organizationId={org}
                  list={shown}
                  view={view}
                  filtered={state === 'unmatched'}
                  clear={() => {}}
                  showAll={() => {}}
                />
              }
              sort={sort}
              onSortChange={setSort}
              columnState={{
                columns: [
                  'name',
                  'stage',
                  'items',
                  'refund',
                  'requested',
                  'activity',
                ].map((key) => ({ key })),
              }}
              onColumnStateChange={() => {}}
              properties={['items', 'refund', 'requested']}
              current={open}
              selection={{ selected, onChange: setSelected }}
              groupLabel={(key) => returnGroupLabel('stage', undefined, key)}
              more={(group) => ({
                rows: [],
                load: group.nextCursor ? () => {} : undefined,
                pending: false,
                failed: false,
              })}
              collapsed={collapsed}
              onCollapsedChange={(id, closed) =>
                setCollapsed((current) =>
                  closed
                    ? [...current, id]
                    : current.filter((item) => item !== id),
                )
              }
            />
          )
        }
        pagination={
          !hidden && !grouping && shown.items.length ? (
            <Pagination
              count={shown.items.length}
              totalCount={shown.counts.views.all}
              page={1}
              pageSize={50}
              hasNext={false}
              onNext={() => {}}
              formatTotal={(count) =>
                m.returns_list_pagination_total({ count })
              }
              label={m.returns_list_pagination_label()}
            />
          ) : null
        }
        preview={
          state === 'preview'
            ? {
                open: !!openReturn,
                title: openReturn?.name,
                content: openReturn ? (
                  <ReturnPreview
                    organizationId={org}
                    returnId={openReturn.id}
                    item={openReturn}
                    sourceLabel={returnSourceLabel(sources)}
                    sourceSystem={(id) =>
                      sources.find((source) => source.connectionId === id)
                        ?.system ?? null
                    }
                    filter={() => {}}
                  />
                ) : null,
                onClose: () => setOpen(undefined),
              }
            : undefined
        }
      />
    </QueryClientProvider>
  );
}

function Content({ state }: { state: string }) {
  if (state === 'detail' || state === 'closed' || state === 'requested')
    return (
      <ReturnDetailView
        organizationId={org}
        detail={
          state === 'closed'
            ? closed
            : state === 'requested'
              ? requested
              : detail
        }
        refresh={() => {}}
      />
    );
  if (state === 'not-found')
    return (
      <ReturnDetailView
        organizationId={org}
        error="missing"
        refresh={() => {}}
      />
    );

  return <ListContent state={state} />;
}

function Preview({ state = 'list' }: { state?: string }) {
  const [router] = useState(() =>
    createRouter({
      history: createMemoryHistory(),
      routeTree: createRootRoute({
        component: () => (
          <>
            <style>{appStyles}</style>
            <Content state={state} />
          </>
        ),
      }),
    }),
  );

  return <RouterProvider router={router} />;
}

const meta = {
  title: 'Returns/Workspace',
  component: Preview,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof Preview>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Browse: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole('link', { name: '#1004-R1' }),
    ).toBeVisible();
    // A pending refund is never shown as money returned.
    await expect(canvas.getByText('€48.00 processing')).toBeVisible();
    await expect(canvas.queryByText(/€48.00 refunded/)).toBeNull();
    // JTL does not share returns, and the page says so.
    await expect(
      canvas.getByText(/JTL-Wawi doesn’t share returns with Luma/),
    ).toBeVisible();
    await userEvent.click(
      canvas.getByRole('button', { name: /^Refund failed/ }),
    );
    await expect(
      canvas.getByRole('button', { name: /^Refund failed/ }),
    ).toHaveAttribute('aria-pressed', 'true');
    // The chosen stage is an applied filter chip that can be removed.
    await userEvent.click(
      canvas.getByRole('button', {
        name: 'Remove Stage filter: Refund failed',
      }),
    );
    await expect(
      canvas.getByRole('button', { name: /^Refund failed/ }),
    ).toHaveAttribute('aria-pressed', 'false');
  },
};

export const Dark: Story = { globals: { theme: 'dark' } };

export const Rows: Story = {
  args: { state: 'rows' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole('list', { name: /Returns and refunds/ }),
    ).toBeVisible();
    await expect(canvas.getByRole('link', { name: /#1002-R1/ })).toBeVisible();
    await expect(canvas.getByText('Order #1002 · Tokyo store')).toBeVisible();
  },
};

export const Grouped: Story = {
  args: { state: 'grouped' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // The stage cards share the name; the group header is the one that expands.
    const waiting = await canvas.findByRole('button', {
      name: /^Waiting for items/,
      expanded: true,
    });
    await expect(waiting).toHaveAttribute('aria-expanded', 'true');
    await expect(canvas.getByText('Value €288.00')).toBeVisible();
    await expect(canvas.getByText('Incomplete')).toBeVisible();
  },
};

export const Board: Story = {
  args: { state: 'board' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole('region', { name: /Refund failed/ }),
    ).toBeVisible();
    // The store owns the stage, so cards never move between columns.
    await expect(canvas.queryByRole('button', { name: 'Move to…' })).toBeNull();
  },
};

export const BoardDark: Story = {
  args: { state: 'board' },
  globals: { theme: 'dark' },
};

export const OpenPreview: Story = {
  args: { state: 'preview' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const preview = await canvas.findByRole('region', {
      name: 'Return preview',
    });
    await expect(
      within(preview).getByRole('button', { name: 'Filter by Size too small' }),
    ).toBeVisible();
    await expect(
      within(preview).getByRole('link', { name: '#1001' }),
    ).toBeVisible();
  },
};

export const PreviewNarrow: Story = {
  args: { state: 'preview' },
  globals: { viewport: { value: 'mobile1', isRotated: false } },
};

export const NoMatches: Story = {
  args: { state: 'unmatched' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole('heading', {
        name: 'No returns match these filters',
      }),
    ).toBeVisible();
  },
};

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

export const Detail: Story = {
  args: { state: 'detail' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole('list', { name: 'Return progress' }),
    ).toBeVisible();
    await expect(canvas.getByText('Refunded to the customer')).toBeVisible();
    await expect(canvas.getByText('Nothing yet')).toBeVisible();
    await expect(
      canvas.getAllByRole('list', { name: 'Payment attempts' }),
    ).toHaveLength(2);
  },
};

export const DetailDark: Story = {
  args: { state: 'detail' },
  globals: { theme: 'dark' },
};

export const DetailNarrow: Story = {
  args: { state: 'detail' },
  globals: { viewport: { value: 'mobile1', isRotated: false } },
};

export const Requested: Story = {
  args: { state: 'requested' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole('heading', { name: 'Next step: To review' }),
    ).toBeVisible();
  },
};

export const Closed: Story = { args: { state: 'closed' } };

export const NotShared: Story = { args: { state: 'not-shared' } };

export const NothingPending: Story = {
  args: { state: 'nothing-pending' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole('heading', { name: 'No returns need action' }),
    ).toBeVisible();
  },
};

export const NotFound: Story = { args: { state: 'not-found' } };

export const Loading: Story = { args: { state: 'loading' } };

export const Error: Story = { args: { state: 'error' } };

export const Offline: Story = { args: { state: 'offline' } };
