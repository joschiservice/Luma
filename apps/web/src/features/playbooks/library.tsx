import type { PlaybookSummary } from '@luma/api-contract';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Badge } from '@luma/ui/components/primitives/badge';
import { Button } from '@luma/ui/components/primitives/button';
import { CollectionToolbar } from '@luma/ui/components/primitives/collection-toolbar';
import { Empty } from '@luma/ui/components/primitives/empty';
import { Input } from '@luma/ui/components/primitives/input';
import { Select } from '@luma/ui/components/primitives/select';
import { useQuery } from '@tanstack/react-query';
import {
  Link,
  useNavigate,
  useParams,
  useSearch,
} from '@tanstack/react-router';
import { BookOpen, ChevronRight, Search, X } from 'lucide-react';
import { useRef } from 'react';

import { SignInRedirect } from '../identity/common';
import { IdentityError } from '../identity/data';
import { playbookError, playbooksOptions } from './data';
import { OfflineNotice } from './offline';

export const statusNames = {
  active: 'Active',
  inactive: 'Inactive',
  revoked: 'Revoked',
  unavailable: 'Prerequisites missing',
};

export interface PlaybookFilters {
  q?: string | undefined;
  system?: string | undefined;
  status?: string | undefined;
}

/** Validates shareable library filters and ignores unsupported filter values. */
export function parsePlaybookFilters(
  value: Record<string, unknown>,
): PlaybookFilters {
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

/** Lists searchable published playbooks in the active workspace. */
export function PlaybooksPage() {
  const { organizationId } = useParams({ from: '/app/$organizationId' });
  const filters = useSearch({ from: '/app/$organizationId/playbooks/' });
  const navigate = useNavigate({ from: '/app/$organizationId/playbooks/' });
  const query = useQuery(playbooksOptions(organizationId));
  if (query.error instanceof IdentityError && query.error.status === 401)
    return <SignInRedirect />;

  return (
    <PlaybookLibraryView
      organizationId={organizationId}
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
      error={query.error ? playbookError(query.error) : undefined}
      refresh={() => void query.refetch()}
    />
  );
}

/** Presents library loading, error, empty and filtered states with accessible controls. */
export function PlaybookLibraryView({
  organizationId,
  items,
  filters,
  change,
  loading,
  refreshing,
  error,
  refresh,
}: {
  organizationId: string;
  items?: PlaybookSummary[] | undefined;
  filters: PlaybookFilters;
  change: (filters: PlaybookFilters) => void;
  loading?: boolean;
  refreshing?: boolean;
  error?: string | undefined;
  refresh: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const search = (filters.q ?? '').trim().toLowerCase();
  const matching = items?.filter(
    (item) =>
      (!filters.system || item.systems.includes(filters.system)) &&
      [
        item.name,
        item.purpose,
        item.issueType.replaceAll('_', ' '),
        ...item.systems,
      ]
        .join(' ')
        .toLowerCase()
        .includes(search),
  );
  const filtered = matching?.filter(
    (item) => !filters.status || item.status === filters.status,
  );
  const activeFilters = [
    ...(filters.q
      ? [
          {
            key: 'q',
            label: `Search: ${filters.q}`,
            onRemove: () => change({ ...filters, q: '' }),
          },
        ]
      : []),
    ...(filters.system
      ? [
          {
            key: 'system',
            label: filters.system,
            onRemove: () => change({ ...filters, system: '' }),
          },
        ]
      : []),
    ...(filters.status
      ? [
          {
            key: 'status',
            label: statusNames[filters.status as keyof typeof statusNames],
            onRemove: () => change({ ...filters, status: '' }),
          },
        ]
      : []),
  ];

  return (
    <div className="playbooks-page playbook-library-page">
      <h1 className="sr-only">Playbooks</h1>
      <OfflineNotice />
      <div className="playbook-collection">
        <CollectionToolbar
          views={
            <>
              <Select
                className="playbook-mobile-view"
                aria-label="Activation status"
                value={filters.status ?? ''}
                options={[
                  ['', 'All playbooks'],
                  ...Object.entries(statusNames),
                ].map(([value, label]) => ({
                  value: value!,
                  label: `${label} (${items ? (value ? matching?.filter((item) => item.status === value).length : matching?.length) : '—'})`,
                }))}
                onValueChange={(value) =>
                  change({ ...filters, status: value ?? '' })
                }
              />
              <div
                className="playbook-views"
                role="group"
                aria-label="Activation status"
              >
                {[['', 'All playbooks'], ...Object.entries(statusNames)].map(
                  ([value, label]) => (
                    <Button
                      key={value}
                      variant="ghost"
                      aria-pressed={(filters.status ?? '') === value}
                      onClick={() => change({ ...filters, status: value })}
                    >
                      {label}
                      <span className="playbook-view-count">
                        {items
                          ? value
                            ? matching?.filter((item) => item.status === value)
                                .length
                            : matching?.length
                          : '—'}
                      </span>
                    </Button>
                  ),
                )}
              </div>
            </>
          }
          filters={activeFilters}
          onClear={() => change({})}
          onRefresh={refresh}
          refreshing={refreshing}
          refreshLabel="Refresh playbooks"
        >
          <div className="playbook-search">
            <Search size={16} aria-hidden="true" />
            <Input
              ref={input}
              type="search"
              aria-label="Search playbooks"
              value={filters.q ?? ''}
              onChange={(event) =>
                change({ ...filters, q: event.target.value })
              }
              placeholder="Search playbooks…"
            />
            {filters.q ? (
              <Button
                variant="ghost"
                size="icon"
                aria-label="Clear search"
                onClick={() => {
                  change({ ...filters, q: '' });
                  input.current?.focus();
                }}
              >
                <X aria-hidden="true" />
              </Button>
            ) : null}
          </div>
          <Select
            aria-label="System"
            value={filters.system ?? ''}
            onValueChange={(value) =>
              change({ ...filters, system: value ?? '' })
            }
            options={[
              { value: '', label: 'All systems' },
              ...[
                ...new Set((items ?? []).flatMap((item) => item.systems)),
              ].map((value) => ({
                value,
                label: value,
              })),
            ]}
          />
        </CollectionToolbar>
        {error ? (
          <Alert tone="danger" role="alert" className="playbook-notice">
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
          <PlaybookLoading />
        ) : !items?.length ? (
          <Empty className="playbook-empty">
            <BookOpen size={28} aria-hidden="true" />
            <h2>No published playbooks</h2>
            <p>
              A workspace administrator must publish a reviewed version before
              it can be activated.
            </p>
          </Empty>
        ) : !filtered?.length ? (
          <Empty className="playbook-empty">
            <Search size={24} aria-hidden="true" />
            <h2>No matching playbooks</h2>
            <p>Try a different search, system, or activation status.</p>
          </Empty>
        ) : (
          <ul className="playbook-rows" aria-label="Playbooks">
            {filtered.map((item) => (
              <li key={item.id}>
                <Link
                  className="playbook-row"
                  aria-label={item.name}
                  to="/app/$organizationId/playbooks/$definitionId"
                  params={{ organizationId, definitionId: item.id }}
                  search={filters}
                >
                  <span className="playbook-row-icon">
                    <BookOpen size={18} aria-hidden="true" />
                  </span>
                  <div className="playbook-row-content">
                    <h2>{item.name}</h2>
                    <p>{item.purpose}</p>
                    <div className="playbook-row-meta">
                      <span>
                        {item.systems.map((system) => system).join(' · ') ||
                          'Unsupported system'}
                      </span>
                      <span>{item.issueType.replaceAll('_', ' ')}</span>
                      <span>v{item.availableVersion}</span>
                      {item.activeVersions.length ? (
                        <span>Active: {item.activeVersions.join(', ')}</span>
                      ) : null}
                    </div>
                    {item.blockers.length ? (
                      <p className="playbook-row-blocker">
                        {item.blockers[0]}
                        {item.blockers.length > 1
                          ? ` (+${item.blockers.length - 1} more)`
                          : ''}
                      </p>
                    ) : null}
                  </div>
                  <Badge
                    tone={
                      item.status === 'active'
                        ? 'success'
                        : item.status === 'unavailable'
                          ? 'warning'
                          : 'neutral'
                    }
                  >
                    {statusNames[item.status]}
                  </Badge>
                  <ChevronRight
                    className="playbook-row-chevron"
                    size={16}
                    aria-hidden="true"
                  />
                </Link>
              </li>
            ))}
          </ul>
        )}
        {!loading && items ? (
          <p role="status" className="playbook-count">
            {filtered?.length ?? 0} of {items.length}{' '}
            {items.length === 1 ? 'playbook' : 'playbooks'}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/** Reserves content space and announces loading without exposing decorative placeholders. */
export function PlaybookLoading({ detail = false }: { detail?: boolean }) {
  return (
    <div className="playbook-loading" role="status">
      <span className="sr-only">
        {detail ? 'Loading playbook…' : 'Loading playbooks…'}
      </span>
      {[0, 1, 2].map((row) => (
        <div key={row} aria-hidden="true" className="playbook-skeleton">
          <span />
          <span />
          <span />
        </div>
      ))}
    </div>
  );
}
