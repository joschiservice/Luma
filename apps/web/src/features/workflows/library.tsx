import './workflows.css';

import type { WorkflowDraft, WorkflowSummary } from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
import { rich } from '@luma/i18n/rich';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Badge } from '@luma/ui/components/primitives/badge';
import { Button, buttonVariants } from '@luma/ui/components/primitives/button';
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
  FilePenLine,
  Plug,
  Plus,
  Search,
  Workflow,
} from 'lucide-react';

import { SignInRedirect } from '../identity/common';
import { IdentityError } from '../identity/data';
import { usePermissions } from '../identity/permissions';
import { draftsOptions } from './authoring/data';
import { workflowError, workflowsOptions } from './data';
import { OfflineNotice } from './offline';
import { workflowCategoryLabel, workflowSystemLabel } from './presentation';
import {
  needsAttention,
  ReadinessPills,
  RepairLink,
  unitCount,
} from './readiness';

/** Library views. Enablement and readiness are separate, so a view never hides a blocker. */
export const statusNames = {
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

/** Lists searchable published workflows in the active workspace. */
export function WorkflowsPage() {
  const { organizationId } = useParams({ from: '/app/$organizationId' });
  const filters = useSearch({ from: '/app/$organizationId/workflows/' });
  const navigate = useNavigate({ from: '/app/$organizationId/workflows/' });
  const query = useQuery(workflowsOptions(organizationId));
  const drafts = useQuery(draftsOptions(organizationId));
  const permissions = usePermissions(organizationId);
  if (query.error instanceof IdentityError && query.error.status === 401)
    return <SignInRedirect />;

  return (
    <WorkflowLibraryView
      organizationId={organizationId}
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
  loading?: boolean;
  refreshing?: boolean;
  error?: string | undefined;
  refresh: () => void;
}) {
  const search = (filters.q ?? '').trim().toLowerCase();
  const matching = items?.filter(
    (item) =>
      (!filters.system || item.systems.includes(filters.system)) &&
      [
        item.name,
        item.purpose,
        workflowCategoryLabel(item.category),
        ...item.systems,
      ]
        .join(' ')
        .toLowerCase()
        .includes(search),
  );
  const filtered = matching?.filter((item) => inView(item, filters.status));
  const count = (value: string) =>
    matching?.filter((item) => inView(item, value)).length ?? 0;

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
      {drafts?.length ? (
        <DraftList
          organizationId={organizationId}
          drafts={drafts}
          canEdit={canCreate}
        />
      ) : null}
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
        ) : !items?.length ? (
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
        ) : !filtered?.length ? (
          <Empty className="workflow-empty">
            <Search size={24} aria-hidden="true" />
            <h2>{m.workflows_library_filtered_title()}</h2>
            <p>{m.workflows_library_filtered_body()}</p>
          </Empty>
        ) : (
          <ul
            className="workflow-rows"
            aria-label={m.workflows_library_list_label()}
          >
            {filtered.map((item) => {
              const next = item.readiness.nextAction;

              return (
                <li key={item.id} className="workflow-row">
                  <DomainIcon
                    domain={
                      item.category === 'resolution'
                        ? 'workflows'
                        : 'procurement'
                    }
                    size="md"
                    className="workflow-row-icon"
                  />
                  <div className="workflow-row-content">
                    <h2>
                      <Link
                        className="workflow-row-link"
                        to="/app/$organizationId/workflows/$definitionId"
                        params={{ organizationId, definitionId: item.id }}
                        search={filters}
                      >
                        {item.name}
                      </Link>
                    </h2>
                    <p>{item.purpose}</p>
                    <div className="workflow-row-meta">
                      <span>{workflowCategoryLabel(item.category)}</span>
                      <span>
                        {item.systems.map(workflowSystemLabel).join(' · ') ||
                          m.workflows_library_no_system()}
                      </span>
                      <span>
                        {item.readiness.coverage.covered === null
                          ? m.workflows_library_coverage_unknown()
                          : m.workflows_library_covers({
                              coverage: unitCount(
                                item.readiness.coverage.covered,
                                item.readiness.coverage.unit,
                              ),
                            })}
                      </span>
                      <span>
                        {m.workflows_version_short({
                          version: item.availableVersion,
                        })}
                      </span>
                    </div>
                    <div
                      className="workflow-row-next"
                      data-state={item.readiness.state}
                    >
                      {next.repair ? (
                        <>
                          <span className="workflow-row-next-label">
                            {m.workflows_next()}
                          </span>
                          <RepairLink
                            organizationId={organizationId}
                            definitionId={item.id}
                            repair={next.repair}
                            label={next.label}
                            className="workflow-repair-link workflow-row-repair"
                          />
                          {item.readiness.state !== 'ready' ? (
                            <span className="workflow-row-reason">
                              {next.description}
                            </span>
                          ) : null}
                        </>
                      ) : (
                        <span className="workflow-row-reason">
                          {next.description}
                        </span>
                      )}
                    </div>
                  </div>
                  <ReadinessPills readiness={item.readiness} />
                  <ChevronRight
                    className="workflow-row-chevron"
                    size={16}
                    aria-hidden="true"
                  />
                </li>
              );
            })}
          </ul>
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

/** Lists open drafts with how and when they were last edited. Drafts never run. */
export function DraftList({
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
    <section
      className="workflow-drafts"
      aria-labelledby="workflow-drafts-title"
    >
      <h2 id="workflow-drafts-title">{m.workflows_drafts_title()}</h2>
      <ul className="workflow-rows">
        {drafts.map((draft) => (
          <li key={draft.id}>
            <Link
              className="workflow-row"
              to="/app/$organizationId/workflows/drafts/$draftId"
              params={{ organizationId, draftId: draft.id }}
              search={{ view: 'build' }}
            >
              <FilePenLine
                size={18}
                aria-hidden="true"
                className="workflow-row-icon"
              />
              <div className="workflow-row-content">
                <h3>
                  {draft.content.definition.name ||
                    m.workflows_drafts_untitled()}
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
            </Link>
          </li>
        ))}
      </ul>
    </section>
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
