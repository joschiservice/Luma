import './workflows.css';

import {
  type WorkflowDraft,
  workflowsCatalog,
  type WorkflowSummary,
} from '@luma/api-contract';
import { formatList } from '@luma/i18n/format';
import { m } from '@luma/i18n/messages';
import { rich } from '@luma/i18n/rich';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Badge } from '@luma/ui/components/primitives/badge';
import { Button, buttonVariants } from '@luma/ui/components/primitives/button';
import { CollectionGroups } from '@luma/ui/components/primitives/collection-groups';
import {
  CollectionToolbar,
  CollectionViews,
} from '@luma/ui/components/primitives/collection-toolbar';
import { DomainIcon } from '@luma/ui/components/primitives/domain-icon';
import { Empty } from '@luma/ui/components/primitives/empty';
import { WorkspaceDate } from '@luma/ui/components/primitives/workspace-date';
import { PageTitle } from '@luma/ui/components/workspace/page-header';
import { useQuery } from '@tanstack/react-query';
import {
  Link,
  useNavigate,
  useParams,
  useSearch,
} from '@tanstack/react-router';
import {
  ChevronRight,
  CircleCheck,
  FilePenLine,
  Plug,
  Plus,
  Search,
  Workflow,
  Zap,
} from 'lucide-react';
import type { ReactNode } from 'react';

import { useCollectionView } from '../../kit/collections/use-collection-view';
import { SignInRedirect } from '../../kit/identity/common';
import { IdentityError } from '../../kit/identity/data';
import { usePermissions } from '../../kit/identity/permissions';
import { draftsOptions } from './authoring/data';
import { workflowError, workflowsOptions } from './data';
import { OfflineNotice } from './offline';
import {
  needsAttention,
  workflowCategoryLabel,
  workflowDomain,
  workflowLifecycle,
  workflowLifecycleLabel,
  workflowLifecycles,
  workflowSystemLabel,
  workflowTriggerKindLabel,
  workflowTriggerKinds,
  workflowTriggerLabel,
} from './presentation';
import { ReadinessPills, RecentRuns, RepairLink, unitCount } from './readiness';

/**
 * Library views. "On" and "Off" follow enablement alone, so a view never hides a blocker; "Needs
 * attention" collects what is on but can't fully run, waits for a person or ended unresolved.
 */
const statusNames = {
  attention: m.workflows_library_view_attention,
  enabled: m.workflows_library_view_enabled,
  not_enabled: m.workflows_library_view_not_enabled,
};

const libraryViews = ['all', 'attention', 'enabled', 'not_enabled'] as const;

const inView = (item: WorkflowSummary, status: string | undefined) =>
  !status ||
  (status === 'attention'
    ? needsAttention(item.readiness)
    : status === 'enabled'
      ? item.readiness.enablement === 'enabled'
      : item.readiness.enablement !== 'enabled');

export interface WorkflowFilters {
  q?: string | undefined;
  system?: string | undefined;
  /** A trigger kind, such as `exception`. */
  trigger?: string | undefined;
  status?: string | undefined;
}

export interface WorkflowDetailSearch extends WorkflowFilters {
  /** A stock position to preselect in stock-rule setup. */
  setup?: string | undefined;
}

/** Validates shareable library filters and ignores unsupported filter values. */
export function parseWorkflowFilters(
  value: Record<string, unknown>,
): WorkflowFilters {
  return {
    q: typeof value.q === 'string' ? value.q.slice(0, 200) : '',
    system:
      typeof value.system === 'string' && value.system.length <= 100
        ? value.system
        : '',
    trigger:
      typeof value.trigger === 'string' &&
      workflowTriggerKinds.some((kind) => kind === value.trigger)
        ? value.trigger
        : '',
    status:
      typeof value.status === 'string' &&
      Object.hasOwn(statusNames, value.status)
        ? value.status
        : '',
  };
}

/** Adds the stock position to preselect when a record links to rule setup. */
export function parseWorkflowDetailSearch(
  value: Record<string, unknown>,
): WorkflowDetailSearch {
  const setup =
    typeof value.setup === 'string' &&
    /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(
      value.setup,
    )
      ? value.setup
      : undefined;

  return { ...parseWorkflowFilters(value), ...(setup ? { setup } : {}) };
}

/** Scopes remembered collapsed groups to the lifecycle grouping. */
const groupPrefix = 'lifecycle=';

/** Lists searchable published workflows in the active workspace. */
export function WorkflowsPage() {
  const { organizationId } = useParams({ from: '/app/$organizationId' });
  const filters = useSearch({ from: '/app/$organizationId/workflows/' });
  const navigate = useNavigate({ from: '/app/$organizationId/workflows/' });
  const query = useQuery(workflowsOptions(organizationId));
  const drafts = useQuery(draftsOptions(organizationId));
  const permissions = usePermissions(organizationId);
  // Only personal display settings are kept as list state: the library has no saved views, and
  // its filters stay in its own URL parameters.
  const view = useCollectionView({
    catalog: workflowsCatalog,
    organizationId,
    search: {},
    navigate: () => {
      // The page never opens another view, so the hook never navigates.
    },
  });
  if (query.error instanceof IdentityError && query.error.status === 401)
    return <SignInRedirect />;

  return (
    <WorkflowLibraryView
      organizationId={organizationId}
      collapsed={view.display.collapsedGroups
        .filter((id) => id.startsWith(groupPrefix))
        .map((id) => id.slice(groupPrefix.length))}
      onCollapsedChange={(key, closed) =>
        view.setDisplay({
          ...view.display,
          collapsedGroups: [
            ...view.display.collapsedGroups.filter(
              (id) => id !== `${groupPrefix}${key}`,
            ),
            ...(closed ? [`${groupPrefix}${key}`] : []),
          ].slice(-100),
        })
      }
      drafts={drafts.data}
      canCreate={permissions.can('workflows.author')}
      items={
        query.error instanceof IdentityError &&
        [401, 403, 404].includes(query.error.status)
          ? undefined
          : query.data
      }
      filters={filters}
      change={(next) => void navigate({ search: next, replace: true })}
      loading={query.isPending}
      refreshing={query.isFetching}
      error={query.error ? workflowError(query.error) : undefined}
      refresh={() => void query.refetch()}
    />
  );
}

/** Presents library loading, error, empty and filtered states with accessible controls. */
export function WorkflowLibraryView({
  organizationId,
  items,
  drafts,
  canCreate = false,
  filters,
  change,
  collapsed,
  onCollapsedChange,
  loading,
  refreshing,
  error,
  refresh,
}: {
  organizationId: string;
  items?: WorkflowSummary[] | undefined;
  drafts?: WorkflowDraft[] | undefined;
  canCreate?: boolean;
  filters: WorkflowFilters;
  change: (filters: WorkflowFilters) => void;
  /** Collapsed lifecycle groups and drafts, a personal display setting. */
  collapsed: readonly string[];
  onCollapsedChange: (key: string, collapsed: boolean) => void;
  loading?: boolean;
  refreshing?: boolean;
  error?: string | undefined;
  refresh: () => void;
}) {
  const search = (filters.q ?? '').trim().toLowerCase();
  const matches = (...values: string[]) =>
    values.join(' ').toLowerCase().includes(search);
  const matching = items?.filter(
    (item) =>
      (!filters.system || item.systems.includes(filters.system)) &&
      (!filters.trigger || item.trigger.kind === filters.trigger) &&
      matches(
        item.name,
        item.purpose,
        workflowCategoryLabel(item.category),
        workflowTriggerLabel(item.trigger),
        ...item.systems.map(workflowSystemLabel),
      ),
  );
  const filtered = matching?.filter((item) => inView(item, filters.status));
  const count = (value: string) =>
    matching?.filter((item) => inView(item, value)).length ?? 0;
  // Drafts never run, so they only appear beside every workflow, not in a status view.
  const shownDrafts =
    !filters.status && !filters.system && !filters.trigger
      ? (drafts ?? []).filter((draft) =>
          matches(
            draft.content.definition.name || m.workflows_drafts_untitled(),
          ),
        )
      : [];
  const groups: {
    key: string;
    label: string;
    count: number;
    content: ReactNode;
  }[] = [
    ...workflowLifecycles.flatMap((lifecycle) => {
      const rows = (filtered ?? []).filter(
        (item) => workflowLifecycle(item.readiness) === lifecycle,
      );

      return rows.length
        ? [
            {
              key: lifecycle,
              label: workflowLifecycleLabel(lifecycle),
              count: rows.length,
              content: (
                <ul
                  className="workflow-rows"
                  aria-label={workflowLifecycleLabel(lifecycle)}
                >
                  {rows.map((item) => (
                    <WorkflowRow
                      key={item.id}
                      item={item}
                      organizationId={organizationId}
                      filters={filters}
                    />
                  ))}
                </ul>
              ),
            },
          ]
        : [];
    }),
    ...(shownDrafts.length
      ? [
          {
            key: 'drafts',
            label: m.workflows_drafts_title(),
            count: shownDrafts.length,
            content: (
              <DraftList
                organizationId={organizationId}
                drafts={shownDrafts}
                canEdit={canCreate}
              />
            ),
          },
        ]
      : []),
  ];

  return (
    <div className="workflows-page workflow-library-page">
      <PageTitle
        title={m.workflows_title()}
        actions={
          <Link
            className={buttonVariants()}
            to="/app/$organizationId/workflows/new"
            params={{ organizationId }}
            search={{}}
          >
            <Plus aria-hidden="true" /> {m.workflows_library_new()}
          </Link>
        }
      />
      <OfflineNotice />
      <div className="workflow-collection">
        <CollectionToolbar
          views={
            <CollectionViews
              label={m.workflows_library_view_label()}
              value={
                libraryViews.find((view) => view === filters.status) ?? 'all'
              }
              views={libraryViews.map((value) => ({
                value,
                label:
                  value === 'all'
                    ? m.workflows_library_view_all()
                    : statusNames[value](),
                count: items ? count(value === 'all' ? '' : value) : undefined,
                attention: value === 'attention',
              }))}
              onChange={(view) =>
                change({ ...filters, status: view === 'all' ? '' : view })
              }
            />
          }
          search={{
            value: filters.q || undefined,
            onChange: (q) => change({ ...filters, q: q ?? '' }),
            label: m.workflows_library_search_label(),
            placeholder: m.workflows_library_search_placeholder(),
            maxLength: 200,
          }}
          filters={[
            {
              kind: 'choice',
              key: 'trigger',
              label: m.workflows_library_filter_trigger(),
              icon: Zap,
              value: filters.trigger || undefined,
              options: workflowTriggerKinds
                .filter(
                  (kind) =>
                    kind === filters.trigger ||
                    items?.some((item) => item.trigger.kind === kind),
                )
                .map((value) => ({
                  value,
                  label: workflowTriggerKindLabel(value),
                })),
              onChange: (trigger) =>
                change({ ...filters, trigger: trigger ?? '' }),
            },
            {
              kind: 'choice',
              key: 'system',
              label: m.workflows_library_filter_system(),
              icon: Plug,
              value: filters.system || undefined,
              options: [
                ...new Set([
                  ...(items ?? []).flatMap((item) => item.systems),
                  ...(filters.system ? [filters.system] : []),
                ]),
              ].map((value) => ({
                value,
                label: workflowSystemLabel(value),
              })),
              onChange: (system) =>
                change({ ...filters, system: system ?? '' }),
            },
          ]}
          onClear={() => change({ status: filters.status })}
          onRefresh={refresh}
          refreshing={refreshing}
          refreshLabel={m.workflows_library_refresh()}
        />
        {error ? (
          <Alert tone="danger" role="alert" className="workflow-notice">
            <span>
              {items ? m.workflows_library_error_stale({ error }) : error}
            </span>
            <Button variant="outline" disabled={refreshing} onClick={refresh}>
              {m.common_retry()}
            </Button>
          </Alert>
        ) : null}
        {error && !items ? null : loading ? (
          <WorkflowLoading />
        ) : !items?.length && !shownDrafts.length ? (
          <Empty className="workflow-empty">
            <Workflow size={28} aria-hidden="true" />
            <h2>{m.workflows_library_empty_title()}</h2>
            <p>{m.workflows_library_empty_body()}</p>
            <Link
              to="/app/$organizationId/workflows/new"
              params={{ organizationId }}
              search={{}}
            >
              {m.workflows_library_new()}
            </Link>
          </Empty>
        ) : groups.length ? (
          <CollectionGroups
            label={m.workflows_library_groups_label()}
            groups={groups}
            collapsed={collapsed}
            onCollapsedChange={onCollapsedChange}
          />
        ) : filters.status === 'attention' &&
          !search &&
          !filters.system &&
          !filters.trigger ? (
          <Empty className="workflow-empty">
            <CircleCheck size={24} aria-hidden="true" />
            <h2>{m.workflows_library_attention_empty_title()}</h2>
            <p>{m.workflows_library_attention_empty_body()}</p>
          </Empty>
        ) : (
          <Empty className="workflow-empty">
            <Search size={24} aria-hidden="true" />
            <h2>{m.workflows_library_filtered_title()}</h2>
            <p>{m.workflows_library_filtered_body()}</p>
          </Empty>
        )}
        {!loading && items ? (
          <p role="status" className="workflow-count">
            {m.workflows_library_count({
              shown: filtered?.length ?? 0,
              total: items.length,
            })}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/**
 * One workflow: what it does, where it stands and what happened recently. The title link covers
 * the row; a repair link for the next step stays separately reachable.
 */
function WorkflowRow({
  item,
  organizationId,
  filters,
}: {
  item: WorkflowSummary;
  organizationId: string;
  filters: WorkflowFilters;
}) {
  const { readiness } = item;
  const next = readiness.nextAction;
  const lifecycle = workflowLifecycle(readiness);
  const outcomes = readiness.outcomes;
  const showNext = lifecycle !== 'on' && lifecycle !== 'paused';

  return (
    <li className="workflow-row" data-lifecycle={lifecycle}>
      <DomainIcon
        domain={workflowDomain(item.category)}
        size="md"
        className="workflow-row-icon"
      />
      <div className="workflow-row-content">
        <h3>
          <Link
            className="workflow-row-link"
            to="/app/$organizationId/workflows/$definitionId"
            params={{ organizationId, definitionId: item.id }}
            search={filters}
          >
            {item.name}
          </Link>
        </h3>
        <p className="workflow-row-purpose">{item.purpose}</p>
        <div className="workflow-row-meta">
          <span>{workflowCategoryLabel(item.category)}</span>
          <span>{workflowTriggerLabel(item.trigger)}</span>
          {item.systems.length ? (
            <span>{formatList(item.systems.map(workflowSystemLabel))}</span>
          ) : null}
          {readiness.enablement !== 'not_enabled' ? (
            <span>
              {readiness.coverage.covered === null
                ? m.workflows_library_coverage_unknown()
                : m.workflows_library_covers({
                    coverage: unitCount(
                      readiness.coverage.covered,
                      readiness.coverage.unit,
                    ),
                  })}
            </span>
          ) : null}
          {outcomes?.latest ? (
            <span>
              {rich(m.workflows_library_last_run, {
                date: <WorkspaceDate value={outcomes.latest.at} />,
              })}
            </span>
          ) : null}
          {outcomes?.runs ? (
            <span>
              {m.workflows_outcomes_verified({ count: outcomes.verified })}
            </span>
          ) : null}
          {outcomes?.recent.length ? (
            <RecentRuns recent={outcomes.recent} />
          ) : null}
        </div>
        {showNext ? (
          <div className="workflow-row-next" data-state={readiness.state}>
            {next.repair && next.repair.destination !== 'server' ? (
              <RepairLink
                organizationId={organizationId}
                definitionId={item.id}
                repair={next.repair}
                label={next.label}
                className="workflow-repair-link workflow-row-repair"
              />
            ) : null}
            <span className="workflow-row-reason">{next.description}</span>
          </div>
        ) : null}
      </div>
      <ReadinessPills readiness={readiness} />
      <ChevronRight
        className="workflow-row-chevron"
        size={16}
        aria-hidden="true"
      />
    </li>
  );
}

/** Lists open drafts with how and when they were last edited. Drafts never run. */
function DraftList({
  organizationId,
  drafts,
  canEdit,
}: {
  organizationId: string;
  drafts: WorkflowDraft[];
  canEdit: boolean;
}) {
  const modes = {
    template: m.workflows_drafts_mode_template,
    visual: m.workflows_drafts_mode_visual,
    code: m.workflows_drafts_mode_code,
    language: m.workflows_drafts_mode_language,
  } satisfies Record<WorkflowDraft['mode'], () => string>;

  return (
    <ul className="workflow-rows" aria-label={m.workflows_drafts_title()}>
      {drafts.map((draft) => (
        <li key={draft.id} className="workflow-row" data-lifecycle="draft">
          <span className="workflow-row-icon workflow-draft-icon">
            <FilePenLine size={16} aria-hidden="true" />
          </span>
          <div className="workflow-row-content">
            <h3>
              <Link
                className="workflow-row-link"
                to="/app/$organizationId/workflows/drafts/$draftId"
                params={{ organizationId, draftId: draft.id }}
                search={{ view: 'build' }}
              >
                {draft.content.definition.name || m.workflows_drafts_untitled()}
              </Link>
            </h3>
            <div className="workflow-row-meta">
              <span>{modes[draft.mode]()}</span>
              <span>
                {m.workflows_version({ version: draft.content.version })}
              </span>
              <span>
                {rich(m.workflows_drafts_edited, {
                  date: <WorkspaceDate value={draft.updatedAt} />,
                })}
              </span>
              {draft.basedOn ? (
                <span>
                  {m.workflows_drafts_based_on({
                    workflow: draft.basedOn.definitionId,
                  })}
                </span>
              ) : null}
            </div>
          </div>
          <Badge tone="neutral">
            {canEdit
              ? m.workflows_drafts_badge()
              : m.workflows_drafts_badge_read_only()}
          </Badge>
          <ChevronRight
            className="workflow-row-chevron"
            size={16}
            aria-hidden="true"
          />
        </li>
      ))}
    </ul>
  );
}

/** Reserves content space and announces loading without exposing decorative placeholders. */
export function WorkflowLoading({ detail = false }: { detail?: boolean }) {
  return (
    <div className="workflow-loading" role="status">
      <span className="sr-only">
        {detail ? m.workflows_detail_loading() : m.workflows_library_loading()}
      </span>
      {[0, 1, 2].map((row) => (
        <div key={row} aria-hidden="true" className="workflow-skeleton">
          <span />
          <span />
          <span />
        </div>
      ))}
    </div>
  );
}
