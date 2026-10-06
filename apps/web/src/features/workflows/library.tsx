import './workflows.css';

import type { WorkflowDraft, WorkflowSummary } from '@luma/api-contract';
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
import { PageHeader } from '@luma/ui/components/workspace/page-header';
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
import { contextOptions, IdentityError } from '../identity/data';
import { draftsOptions } from './authoring/data';
import { workflowError, workflowsOptions } from './data';
import { OfflineNotice } from './offline';
import { workflowCategoryLabel, workflowSystemLabel } from './presentation';
import { needsAttention, ReadinessPills, RepairLink } from './readiness';

/** Library views. Enablement and readiness are separate, so a view never hides a blocker. */
export const statusNames = {
  attention: 'Needs attention',
  enabled: 'Enabled',
  not_enabled: 'Not enabled',
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
  const context = useQuery(contextOptions(organizationId));
  if (query.error instanceof IdentityError && query.error.status === 401)
    return <SignInRedirect />;

  return (
    <WorkflowLibraryView
      organizationId={organizationId}
      drafts={drafts.data}
      canCreate={!!context.data && context.data.actor.role !== 'member'}
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
      <PageHeader
        icon={<DomainIcon domain="workflows" size="lg" />}
        title="Workflows"
        description="Workflows watch for issues and stock conditions, propose the changes you’ve agreed on, and verify the result. Each one shows whether it’s on, whether it can run and what needs to happen next."
        actions={
          <Link
            className={buttonVariants()}
            to="/app/$organizationId/workflows/new"
            params={{ organizationId }}
            search={{}}
          >
            <Plus aria-hidden="true" /> New workflow
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
              label="Workflow view"
              value={
                libraryViews.find((view) => view === filters.status) ?? 'all'
              }
              views={libraryViews.map((value) => ({
                value,
                label: value === 'all' ? 'All workflows' : statusNames[value],
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
            label: 'Search workflows',
            placeholder: 'Search workflows…',
            maxLength: 200,
          }}
          filters={[
            {
              kind: 'choice',
              key: 'system',
              label: 'System',
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
          refreshLabel="Refresh workflows"
        />
        {error ? (
          <Alert tone="danger" role="alert" className="workflow-notice">
            <span>
              {error}
              {items ? ' The list below may be out of date.' : ''}
            </span>
            <Button variant="outline" disabled={refreshing} onClick={refresh}>
              Retry
            </Button>
          </Alert>
        ) : null}
        {error && !items ? null : loading ? (
          <WorkflowLoading />
        ) : !items?.length ? (
          <Empty className="workflow-empty">
            <Workflow size={28} aria-hidden="true" />
            <h2>No published workflows</h2>
            <p>
              Start from a template or build your own. An owner or admin
              publishes a reviewed version before it can be activated.
            </p>
            <Link
              to="/app/$organizationId/workflows/new"
              params={{ organizationId }}
              search={{}}
            >
              New workflow
            </Link>
          </Empty>
        ) : !filtered?.length ? (
          <Empty className="workflow-empty">
            <Search size={24} aria-hidden="true" />
            <h2>No matching workflows</h2>
            <p>Try a different search, system or view.</p>
          </Empty>
        ) : (
          <ul className="workflow-rows" aria-label="Workflows">
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
                          'No connected system'}
                      </span>
                      <span>
                        Covers{' '}
                        {item.readiness.coverage.covered === null
                          ? 'unknown scope'
                          : `${item.readiness.coverage.covered} ${item.readiness.coverage.covered === 1 ? item.readiness.coverage.unit : `${item.readiness.coverage.unit}s`}`}
                      </span>
                      <span>v{item.availableVersion}</span>
                    </div>
                    <div
                      className="workflow-row-next"
                      data-state={item.readiness.state}
                    >
                      {next.repair ? (
                        <>
                          <span className="workflow-row-next-label">Next</span>
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
            {filtered?.length ?? 0} of {items.length}{' '}
            {items.length === 1 ? 'workflow' : 'workflows'}
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
    template: 'From a template',
    visual: 'Built visually',
    code: 'Written in code',
    language: 'Described in words',
  } as const;

  return (
    <section
      className="workflow-drafts"
      aria-labelledby="workflow-drafts-title"
    >
      <h2 id="workflow-drafts-title">Drafts</h2>
      <ul>
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
                <h3>{draft.content.definition.name || 'Untitled workflow'}</h3>
                <div className="workflow-row-meta">
                  <span>{modes[draft.mode]}</span>
                  <span>Version {draft.content.version}</span>
                  <span>
                    Edited <WorkspaceDate value={draft.updatedAt} />
                  </span>
                  {draft.basedOn ? (
                    <span>Edits {draft.basedOn.definitionId}</span>
                  ) : null}
                </div>
              </div>
              <Badge tone="neutral">
                {canEdit ? 'Draft' : 'Draft · read only'}
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
        {detail ? 'Loading workflow…' : 'Loading workflows…'}
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
