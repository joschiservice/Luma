import './adaptive.css';

import type { AdaptiveView, AdaptiveViewQuery } from '@luma/api-contract';
import { collectionDomainSchema } from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Badge } from '@luma/ui/components/primitives/badge';
import { Button, buttonVariants } from '@luma/ui/components/primitives/button';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@luma/ui/components/primitives/card';
import { CollectionToolbar } from '@luma/ui/components/primitives/collection-toolbar';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@luma/ui/components/primitives/dialog';
import { Empty } from '@luma/ui/components/primitives/empty';
import { WorkspaceDate } from '@luma/ui/components/primitives/workspace-date';
import { PageTitle } from '@luma/ui/components/workspace/page-header';
import { RecordHeader } from '@luma/ui/components/workspace/record-header';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Link,
  useNavigate,
  useParams,
  useSearch,
} from '@tanstack/react-router';
import { Columns3, Copy, History, Pencil, Plus } from 'lucide-react';
import { useState } from 'react';

import { Pending } from '../../kit/identity/common';
import { usePermissions } from '../../kit/identity/permissions';
import { AdaptiveActions } from './actions';
import {
  adaptiveApi,
  adaptiveAvailabilityOptions,
  adaptiveKey,
  emptyViewQuery,
  previewOptions,
  viewOptions,
  viewsOptions,
} from './data';
import { ViewEditor } from './editor';
import { adaptiveLabel, domainLabel } from './presentation';
import { previewable } from './query-fields';
import { AdaptiveRecords } from './records';

/** Browses authorized saved workspaces and starts manual or reviewed built-in authoring. */
export function ViewsPage() {
  const { organizationId } = useParams({ from: '/app/$organizationId' });
  const search = useSearch({ from: '/app/$organizationId/views/' });
  const navigate = useNavigate();
  const availability = useQuery(adaptiveAvailabilityOptions(organizationId));
  const { can, ready } = usePermissions(organizationId);
  const views = useQuery({
    ...viewsOptions(organizationId),
    enabled: availability.data?.views === true && ready,
  });
  const [draft, setDraft] = useState<AdaptiveViewQuery | null>(null);
  if (!ready) return <Pending />;
  if (availability.isPending) return <Pending />;
  if (!availability.data?.views)
    return (
      <Empty>
        <p>{m.adaptive_unavailable()}</p>
      </Empty>
    );
  const matching = views.data?.items.filter(
    (view) =>
      !view.archived &&
      (!search.domain || view.query.domain === search.domain) &&
      (!search.sharing || view.sharing.scope === search.sharing) &&
      `${view.name} ${view.description}`
        .toLocaleLowerCase()
        .includes((search.q ?? '').toLocaleLowerCase()),
  );
  const directory = (patch: Partial<typeof search>) =>
    void navigate({
      to: '/app/$organizationId/views',
      params: { organizationId },
      search: { ...search, ...patch, cursor: undefined },
    });

  return (
    <div className="adaptive-workspace">
      <PageTitle
        title={m.adaptive_title()}
        actions={
          ready ? (
            <Button onClick={() => setDraft(emptyViewQuery('orders'))}>
              <Plus aria-hidden="true" />
              {m.adaptive_new_view()}
            </Button>
          ) : null
        }
      />
      <div className="adaptive-intro">
        <p>{m.adaptive_description()}</p>
        <div className="adaptive-links">
          {availability.data.fields && can('adaptive.fields.read') ? (
            <Link
              className={buttonVariants({ variant: 'outline' })}
              to="/app/$organizationId/views/fields"
              params={{ organizationId }}
            >
              {m.adaptive_fields_title()}
            </Link>
          ) : null}
          {availability.data.packages ? (
            <Link
              className={buttonVariants({ variant: 'outline' })}
              to="/app/$organizationId/views/packages"
              params={{ organizationId }}
            >
              {m.adaptive_packages_title()}
            </Link>
          ) : null}
        </div>
      </div>
      {draft ? (
        <>
          <h2>{m.adaptive_new_view()}</h2>
          <ViewEditor
            organizationId={organizationId}
            initialQuery={draft}
            generationEnabled={availability.data.generation}
            onClose={() => setDraft(null)}
          />
        </>
      ) : (
        <>
          <CollectionToolbar
            onRefresh={() => void views.refetch()}
            refreshing={views.isFetching}
            search={{
              value: search.q,
              label: m.adaptive_search(),
              placeholder: m.adaptive_search(),
              onChange: (q) => directory({ q }),
            }}
            filters={[
              {
                kind: 'choice',
                key: 'domain',
                label: m.adaptive_directory_list(),
                value: search.domain,
                options: [
                  ...new Set(
                    views.data?.items.map((view) => view.query.domain),
                  ),
                ].map((domain) => ({
                  value: domain,
                  label: domainLabel(domain),
                })),
                onChange: (value) =>
                  directory({
                    domain: collectionDomainSchema.safeParse(value).data,
                  }),
              },
              {
                kind: 'choice',
                key: 'sharing',
                label: m.adaptive_directory_sharing(),
                value: search.sharing,
                options: [
                  { value: 'private', label: m.adaptive_private() },
                  { value: 'workspace', label: m.adaptive_workspace() },
                  { value: 'roles', label: m.adaptive_roles() },
                ],
                onChange: (value) =>
                  directory({
                    sharing:
                      value === 'private' ||
                      value === 'workspace' ||
                      value === 'roles'
                        ? value
                        : undefined,
                  }),
              },
            ]}
            onClear={() =>
              directory({ q: undefined, domain: undefined, sharing: undefined })
            }
          />
          {views.isError ? (
            <Alert tone="warning">
              {m.adaptive_load_failed()}
              <Button variant="outline" onClick={() => void views.refetch()}>
                {m.adaptive_retry()}
              </Button>
            </Alert>
          ) : views.isPending ? (
            <Pending />
          ) : matching?.length ? (
            <div className="adaptive-library">
              {matching.map((view) => (
                <Card key={view.id}>
                  <CardHeader>
                    <div className="adaptive-view-heading">
                      <CardTitle as="h2">
                        <Link
                          to="/app/$organizationId/views/$viewId"
                          params={{ organizationId, viewId: view.id }}
                          search={{}}
                        >
                          {view.name}
                        </Link>
                      </CardTitle>
                      <Badge>
                        {view.sharing.scope === 'private'
                          ? m.adaptive_private()
                          : view.sharing.scope === 'roles'
                            ? m.adaptive_roles()
                            : m.adaptive_workspace()}
                      </Badge>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <div className="adaptive-view-copy">
                      <p>{view.description}</p>
                      <span>
                        {domainLabel(view.query.domain)} ·{' '}
                        {m.adaptive_revision({ revision: view.revision })}
                      </span>
                      <WorkspaceDate value={view.updatedAt} />
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          ) : (
            <Empty>
              <Columns3 aria-hidden="true" />
              <h2>{m.adaptive_empty_title()}</h2>
              <p>{m.adaptive_empty_body()}</p>
            </Empty>
          )}
          {views.data?.builtIns.length ? (
            <section>
              <h2>{m.adaptive_built_in()}</h2>
              <p>{m.adaptive_built_in_note()}</p>
              <div className="adaptive-library">
                {views.data.builtIns.map((view) => (
                  <Card key={view.id}>
                    <CardHeader>
                      <CardTitle as="h3">{adaptiveLabel(view.name)}</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <Button
                        variant="outline"
                        disabled={!ready}
                        onClick={() => setDraft(view.query)}
                      >
                        {m.adaptive_new_view()}
                      </Button>
                    </CardContent>
                  </Card>
                ))}
              </div>
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}

/** Opens a live saved query while preserving unavailable and permission-loss states. */
export function SavedViewPage() {
  const { organizationId, viewId } = useParams({
    from: '/app/$organizationId/views/$viewId',
  });
  const search = useSearch({ from: '/app/$organizationId/views/$viewId' });
  const navigate = useNavigate();
  const availability = useQuery(adaptiveAvailabilityOptions(organizationId));
  const { ready } = usePermissions(organizationId);
  const view = useQuery({
    ...viewOptions(organizationId, viewId),
    enabled: !!availability.data?.views && ready,
  });
  const preview = useQuery({
    ...previewOptions(
      organizationId,
      view.data?.query ?? emptyViewQuery('orders'),
      search.cursor,
    ),
    enabled:
      !!view.data &&
      previewable(view.data.query.domain) &&
      !!availability.data?.views,
  });
  const client = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [history, setHistory] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [restored, setRestored] = useState<AdaptiveView | undefined>();
  const mutation = useMutation({
    mutationFn: async (operation: 'archive' | 'duplicate') => {
      if (!view.data) throw new Error('View unavailable');

      return operation === 'archive'
        ? adaptiveApi.adaptiveViews.archive({
            params: { organizationId, viewId },
            body: { expectedRevision: view.data.revision },
          })
        : adaptiveApi.adaptiveViews.duplicate({
            params: { organizationId, viewId },
            body: {
              commandId: crypto.randomUUID(),
              name: `${view.data.name.slice(0, 110)} (${m.adaptive_duplicate()})`.slice(
                0,
                120,
              ),
            },
          });
    },
    onSuccess: async (saved) => {
      await client.invalidateQueries({ queryKey: adaptiveKey(organizationId) });
      if (saved.archived)
        void navigate({
          to: '/app/$organizationId/views',
          params: { organizationId },
          search: {},
        });
      else
        void navigate({
          to: '/app/$organizationId/views/$viewId',
          params: { organizationId, viewId: saved.id },
          search: { manage: true },
        });
    },
  });
  if (!ready) return <Pending />;
  if (availability.isPending || (view.isPending && availability.data?.views))
    return <Pending />;
  if (!availability.data?.views)
    return (
      <Empty>
        <p>{m.adaptive_unavailable()}</p>
      </Empty>
    );
  if (view.isError || !view.data || view.data.archived)
    return (
      <Empty>
        <p>{m.adaptive_load_failed()}</p>
        <Button variant="outline" onClick={() => void view.refetch()}>
          {m.adaptive_retry()}
        </Button>
      </Empty>
    );
  const saved = view.data;

  return (
    <div className="adaptive-workspace">
      <RecordHeader
        section={{
          label: m.adaptive_title(),
          icon: Columns3,
          link: (
            <Link
              to="/app/$organizationId/views"
              params={{ organizationId }}
              search={{}}
            />
          ),
        }}
        title={saved.name}
        description={saved.description}
        status={
          <Badge>{m.adaptive_revision({ revision: saved.revision })}</Badge>
        }
        actions={
          <>
            <Button variant="outline" onClick={() => setHistory(true)}>
              <History aria-hidden="true" />
              {m.adaptive_history()}
            </Button>
            {ready ? (
              <Button
                variant="outline"
                disabled={mutation.isPending}
                onClick={() => mutation.mutate('duplicate')}
              >
                <Copy aria-hidden="true" />
                {m.adaptive_duplicate()}
              </Button>
            ) : null}
            {saved.canEdit ? (
              <>
                <Button variant="outline" onClick={() => setEditing(!editing)}>
                  <Pencil aria-hidden="true" />
                  {m.adaptive_edit_view()}
                </Button>
                <Button
                  variant="ghost"
                  disabled={mutation.isPending}
                  onClick={() => mutation.mutate('archive')}
                >
                  {m.adaptive_archive()}
                </Button>
              </>
            ) : null}
          </>
        }
      />
      {mutation.isError ? (
        <Alert tone="danger">{m.adaptive_operation_failed()}</Alert>
      ) : null}
      {editing ? (
        <ViewEditor
          key={`${saved.revision}:${restored?.revision ?? ''}`}
          organizationId={organizationId}
          view={
            restored
              ? { ...restored, id: saved.id, revision: saved.revision }
              : saved
          }
          generationEnabled={availability.data.generation}
          onClose={() => {
            setEditing(false);
            setRestored(undefined);
          }}
        />
      ) : (
        <>
          <CollectionToolbar
            onRefresh={() => void preview.refetch()}
            refreshing={preview.isFetching}
          />
          {availability.data.actions ? (
            <AdaptiveActions
              organizationId={organizationId}
              viewId={viewId}
              recordIds={selected}
            />
          ) : null}
          {!previewable(saved.query.domain) ? (
            <Alert>{m.adaptive_preview_unsupported()}</Alert>
          ) : preview.isError ? (
            <Alert tone="warning">
              {m.adaptive_load_failed()}
              <Button variant="outline" onClick={() => void preview.refetch()}>
                {m.adaptive_retry()}
              </Button>
            </Alert>
          ) : preview.isPending ? (
            <Pending />
          ) : preview.data ? (
            <AdaptiveRecords
              organizationId={organizationId}
              configuration={saved.query}
              preview={preview.data}
              selected={selected}
              onSelected={setSelected}
              onFirst={
                search.cursor
                  ? () => {
                      setSelected([]);
                      void navigate({
                        to: '/app/$organizationId/views/$viewId',
                        params: { organizationId, viewId },
                        search: { manage: true },
                      });
                    }
                  : undefined
              }
              onNext={() => {
                setSelected([]);
                void navigate({
                  to: '/app/$organizationId/views/$viewId',
                  params: { organizationId, viewId },
                  search: {
                    cursor: preview.data?.nextCursor ?? undefined,
                    manage: true,
                  },
                });
              }}
            />
          ) : null}
        </>
      )}
      <ViewHistory
        organizationId={organizationId}
        viewId={viewId}
        open={history}
        close={() => setHistory(false)}
        canRestore={saved.canEdit}
        restore={(revision) => {
          setRestored({ ...saved, ...revision });
          setHistory(false);
          setEditing(true);
        }}
      />
    </div>
  );
}

function ViewHistory({
  organizationId,
  viewId,
  open,
  close,
  canRestore,
  restore,
}: {
  organizationId: string;
  viewId: string;
  open: boolean;
  close: () => void;
  canRestore: boolean;
  restore: (revision: Omit<AdaptiveView, 'canEdit'>) => void;
}) {
  const query = useQuery({
    queryKey: [...adaptiveKey(organizationId), 'history', viewId],
    queryFn: ({ signal }) =>
      adaptiveApi.adaptiveViews.history(
        { params: { organizationId, viewId } },
        { signal },
      ),
    enabled: open,
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!value) close();
      }}
    >
      <DialogContent className="adaptive-dialog">
        <DialogHeader>
          <DialogTitle>{m.adaptive_history()}</DialogTitle>
          <DialogDescription>{m.adaptive_restore_note()}</DialogDescription>
        </DialogHeader>
        {query.isPending ? (
          <Pending />
        ) : query.isError ? (
          <Alert tone="warning">{m.adaptive_load_failed()}</Alert>
        ) : (
          query.data?.items.map((revision) => (
            <div className="adaptive-history-row" key={revision.revision}>
              <div>
                <strong>
                  {m.adaptive_revision({ revision: revision.revision })}
                </strong>
                <p>{revision.name}</p>
                <WorkspaceDate value={revision.updatedAt} />
              </div>
              {canRestore ? (
                <Button variant="outline" onClick={() => restore(revision)}>
                  {m.adaptive_restore()}
                </Button>
              ) : null}
            </div>
          ))
        )}
      </DialogContent>
    </Dialog>
  );
}
