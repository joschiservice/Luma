import type { PlaybookSummary } from '@luma/api-contract';
import { Button } from '@luma/ui/button';
import { useQuery } from '@tanstack/react-query';
import {
  Link,
  useNavigate,
  useParams,
  useSearch,
} from '@tanstack/react-router';
import { ArrowUpRight, BookOpen, Search } from 'lucide-react';

import { SignInRedirect } from '../identity/common';
import { IdentityError } from '../identity/data';
import { playbookError, playbooksOptions } from './data';
import { OfflineNotice } from './offline';

export const systemNames: Record<string, string> = {
  'jtl-cloud': 'JTL Cloud',
  'jtl-onprem': 'JTL On-Prem',
  shopify: 'Shopify',
};

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
      typeof value.system === 'string' &&
      Object.hasOwn(systemNames, value.system)
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
  const filtered = items?.filter(
    (p) =>
      p.name.toLowerCase().includes((filters.q ?? '').toLowerCase()) &&
      (!filters.system || p.systems.includes(filters.system)) &&
      (!filters.status || p.status === filters.status),
  );

  return (
    <div className="playbooks-page">
      <OfflineNotice />
      <div className="playbooks-heading">
        <div>
          <p className="playbooks-kicker">
            <BookOpen size={15} aria-hidden="true" /> Resolution library
          </p>
          <h1>Playbooks</h1>
          <p className="desk-intro">
            Understand each correction. Control where a reviewed version may
            run.
          </p>
        </div>
        <Button variant="outline" disabled={refreshing} onClick={refresh}>
          {refreshing ? 'Refreshing…' : 'Refresh playbooks'}
        </Button>
      </div>
      <div className="playbook-filters">
        <label>
          <span>
            <Search size={14} aria-hidden="true" /> Search by name
          </span>
          <input
            type="search"
            value={filters.q ?? ''}
            onChange={(e) => change({ ...filters, q: e.target.value })}
            placeholder="Find a playbook"
          />
        </label>
        <label>
          System
          <select
            aria-label="System"
            value={filters.system ?? ''}
            onChange={(e) => change({ ...filters, system: e.target.value })}
          >
            <option value="">All systems</option>
            {Object.entries(systemNames).map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Activation status
          <select
            aria-label="Activation status"
            value={filters.status ?? ''}
            onChange={(e) => change({ ...filters, status: e.target.value })}
          >
            <option value="">All statuses</option>
            {Object.entries(statusNames).map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </label>
      </div>
      {error ? (
        <div role="alert" className="playbook-notice">
          {error}{' '}
          <Button variant="outline" onClick={refresh}>
            Retry
          </Button>
        </div>
      ) : null}
      {error && !items ? null : loading ? (
        <p role="status">Loading playbooks…</p>
      ) : !items?.length ? (
        <section className="playbook-empty">
          <BookOpen size={28} aria-hidden="true" />
          <h2>No published playbooks</h2>
          <p>
            A workspace administrator must publish a reviewed version before it
            can be activated.
          </p>
        </section>
      ) : (
        <>
          <p role="status" className="playbook-count">
            {filtered?.length} playbooks
          </p>
          {!filtered?.length ? (
            <section className="playbook-empty">
              <h2>No matching playbooks</h2>
              <Button variant="outline" onClick={() => change({})}>
                Clear filters
              </Button>
            </section>
          ) : (
            <div className="playbook-library">
              {filtered.map((p) => (
                <article key={p.id} className="playbook-card">
                  <div className="playbooks-heading">
                    <span className="playbook-status">
                      {statusNames[p.status]}
                    </span>
                    <span>v{p.availableVersion}</span>
                  </div>
                  <h2>
                    <Link
                      to="/app/$organizationId/playbooks/$definitionId"
                      params={{ organizationId, definitionId: p.id }}
                      search={filters}
                    >
                      {p.name}
                      <ArrowUpRight size={18} aria-hidden="true" />
                    </Link>
                  </h2>
                  <p>{p.purpose}</p>
                  <dl>
                    <div>
                      <dt>Issue type</dt>
                      <dd>{p.issueType.replaceAll('_', ' ')}</dd>
                    </div>
                    <div>
                      <dt>Capability</dt>
                      <dd>{p.capability}</dd>
                    </div>
                    <div>
                      <dt>Systems</dt>
                      <dd>
                        {p.systems
                          .map((s) => systemNames[s] ?? s)
                          .join(' · ') || 'Unsupported'}
                      </dd>
                    </div>
                  </dl>
                  {p.activeVersions.length ? (
                    <p>Active versions: {p.activeVersions.join(', ')}</p>
                  ) : null}
                  {p.blockers.map((reason) => (
                    <p className="playbook-notice" key={reason}>
                      {reason}
                    </p>
                  ))}
                </article>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
