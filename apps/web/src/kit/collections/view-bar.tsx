import './collections.css';

import type {
  AdaptiveView,
  CollectionMemberState,
  CollectionViewState,
} from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Badge } from '@luma/ui/components/primitives/badge';
import { Button } from '@luma/ui/components/primitives/button';
import {
  type CollectionView as CollectionViewOption,
  CollectionViews,
} from '@luma/ui/components/primitives/collection-toolbar';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@luma/ui/components/primitives/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@luma/ui/components/primitives/dropdown-menu';
import {
  Field,
  FieldDescription,
  FieldLabel,
} from '@luma/ui/components/primitives/field';
import { Input } from '@luma/ui/components/primitives/input';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ArrowDown, ArrowUp, Ellipsis } from 'lucide-react';
import { useEffect, useId, useState } from 'react';

import { IdentityError } from '../identity/data';
import { usePermissions } from '../identity/permissions';
import { useWorkspaceLayout } from '../layout/data';
import { rolesOptions } from '../settings/roles-data';
import {
  archiveCollectionView,
  createCollectionView,
  exportCollection,
  invalidateCollection,
  updateCollectionView,
} from './data';
import type { CollectionView } from './use-collection-view';

type Sharing = AdaptiveView['sharing'];

/**
 * The view bar of a list page: built-in, personal and shared views as tabs, with those that
 * don't fit in a More menu, the Modified state with Save, Save as new view and Reset, and view
 * options. Each tab links to its view, so it can open in a new browser tab. A list with a single
 * view and no saved views shows no tabs. Saving never shares a view more widely than the member
 * may; sharing never grants record access.
 */
export function CollectionViewBar({
  organizationId,
  view,
  path,
  segmentLabel,
  segments,
  exportColumns,
}: {
  organizationId: string;
  view: CollectionView;
  /**
   * The list's path relative to the workspace root, such as `orders` or
   * `procurement?tab=suppliers`, for pins and links.
   */
  path: string;
  segmentLabel: (segment: string) => string;
  /** Descriptions, icons and counts of the built-in views, by segment. */
  segments?: readonly CollectionViewOption<string>[] | undefined;
  /** The visible columns and their headings; offers CSV export to members who may export. */
  exportColumns?: readonly { id: string; label: string }[] | undefined;
}) {
  const queryClient = useQueryClient();
  const permissions = usePermissions(organizationId);
  const { layout, save: saveLayout } = useWorkspaceLayout(organizationId);
  const [dialog, setDialog] = useState<
    | null
    | { kind: 'save-as' }
    | { kind: 'rename' }
    | { kind: 'archive' }
    | { kind: 'order' }
  >(null);
  const [conflict, setConflict] = useState(false);
  const [undo, setUndo] = useState<CollectionMemberState | null>(null);
  const [copied, setCopied] = useState(false);
  const exporting = useMutation({
    mutationFn: () =>
      exportCollection(organizationId, {
        query: query({
          ...view.state,
          columns: (exportColumns ?? []).map((column) => ({ id: column.id })),
        }),
        labels: {
          ...Object.fromEntries(
            (exportColumns ?? []).map((column) => [column.id, column.label]),
          ),
          '@truncated': m.collections_export_truncated(),
        },
      }),
    onSuccess: (result) => {
      const url = URL.createObjectURL(
        new Blob([result.csv], { type: 'text/csv;charset=utf-8' }),
      );
      const link = document.createElement('a');
      link.href = url;
      link.download = result.filename;
      link.click();
      URL.revokeObjectURL(url);
    },
  });
  const saved = view.saved;
  const name =
    saved?.name ??
    segmentLabel(view.ref.kind === 'builtin' ? view.ref.segment : '');
  const query = (state: CollectionViewState) => ({
    version: 2 as const,
    domain: view.domain,
    state,
    metrics: saved?.query.metrics ?? [],
    charts: saved?.query.charts ?? [],
    actions: saved?.query.actions ?? [],
  });
  const update = useMutation({
    mutationFn: () => {
      if (!saved) throw new Error('No saved view is open.');

      return updateCollectionView(organizationId, saved, {
        query: { ...saved.query, state: view.state },
      });
    },
    onSuccess: async (result) => {
      await invalidateCollection(queryClient, organizationId);
      view.open(result.id);
    },
    onError: (error) => {
      if (error instanceof IdentityError && error.status === 409)
        setConflict(true);
    },
  });
  const archive = useMutation({
    mutationFn: () => {
      if (!saved) throw new Error('No saved view is open.');

      return archiveCollectionView(organizationId, saved);
    },
    onSuccess: async () => {
      setDialog(null);
      await invalidateCollection(queryClient, organizationId);
      view.open(`builtin:${view.base.segment ?? 'all'}`);
    },
  });
  useEffect(() => {
    if (!undo) return;
    const timeout = setTimeout(() => setUndo(null), 10_000);

    return () => clearTimeout(timeout);
  }, [undo]);
  const viewPath = (id: string) =>
    `${path}${path.includes('?') ? '&' : '?'}view=${encodeURIComponent(id)}`;
  const pinPath = viewPath(
    view.ref.kind === 'saved' ? view.ref.id : view.ref.segment,
  );
  const pinned = layout?.pinned.some((pin) => pin.path === pinPath) ?? false;
  const label = (item: (typeof view.views)[number]) =>
    item.kind === 'saved' ? item.view.name : segmentLabel(item.segment);

  const grouped = view.views.some((item) => item.kind === 'saved');
  const views = view.views.map((item): CollectionViewOption<string> => ({
    ...(item.kind === 'builtin'
      ? segments?.find((segment) => segment.value === item.segment)
      : undefined),
    value: item.key,
    label: label(item),
    href: `/app/${organizationId}/${viewPath(item.kind === 'saved' ? item.view.id : item.segment)}`,
    group: grouped
      ? item.kind === 'builtin'
        ? m.collections_views_builtin()
        : item.view.sharing.scope === 'private'
          ? m.collections_views_mine()
          : m.collections_views_shared()
      : undefined,
  }));

  return (
    <div
      className="collection-view-bar"
      data-views={views.length > 1 ? '' : undefined}
    >
      {views.length > 1 ? (
        <CollectionViews
          label={m.collections_views_label()}
          value={
            views.some((item) => item.value === view.key) ? view.key : null
          }
          views={views}
          onChange={(key) => view.open(key)}
          overflow
        />
      ) : null}
      <div className="collection-view-actions">
        {view.modified ? (
          <>
            <Badge tone="info">{m.collections_view_modified()}</Badge>
            {saved?.canEdit ? (
              <Button
                variant="outline"
                onClick={() => update.mutate()}
                disabled={update.isPending}
              >
                {m.collections_view_save()}
              </Button>
            ) : null}
            {view.savedViewsAvailable ? (
              <Button
                variant="outline"
                onClick={() => setDialog({ kind: 'save-as' })}
              >
                {m.collections_view_save_as()}
              </Button>
            ) : null}
            <Button variant="ghost" onClick={view.reset}>
              {m.collections_view_reset()}
            </Button>
          </>
        ) : null}
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon"
                aria-label={m.collections_view_options()}
              >
                <Ellipsis aria-hidden="true" />
              </Button>
            }
          />
          <DropdownMenuContent align="end">
            {view.savedViewsAvailable && !view.modified ? (
              <DropdownMenuItem onClick={() => setDialog({ kind: 'save-as' })}>
                {saved
                  ? m.collections_view_duplicate()
                  : m.collections_view_save_as()}
              </DropdownMenuItem>
            ) : null}
            {saved ? (
              <DropdownMenuItem
                render={
                  <Link
                    to="/app/$organizationId/views/$viewId"
                    params={{ organizationId, viewId: saved.id }}
                    search={{ manage: true }}
                  />
                }
              >
                {m.collections_view_manage()}
              </DropdownMenuItem>
            ) : null}
            {saved?.canEdit ? (
              <>
                <DropdownMenuItem onClick={() => setDialog({ kind: 'rename' })}>
                  {m.collections_view_rename_sharing()}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => setDialog({ kind: 'archive' })}
                >
                  {m.collections_view_archive()}
                </DropdownMenuItem>
              </>
            ) : null}
            {exportColumns?.length && permissions.can('lists.export') ? (
              <DropdownMenuItem
                disabled={exporting.isPending}
                onClick={() => exporting.mutate()}
              >
                {m.collections_export()}
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem
              onClick={() => {
                void navigator.clipboard
                  ?.writeText(window.location.href)
                  .then(() => setCopied(true));
              }}
            >
              {m.collections_view_copy_link()}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() =>
                view.setDefaultView(
                  view.defaultView === view.key ? null : view.key,
                )
              }
            >
              {view.defaultView === view.key
                ? m.collections_view_clear_default()
                : m.collections_view_make_default()}
            </DropdownMenuItem>
            {layout ? (
              <DropdownMenuItem
                disabled={!pinned && layout.pinned.length >= 12}
                onClick={() =>
                  saveLayout({
                    pinned: pinned
                      ? layout.pinned.filter((pin) => pin.path !== pinPath)
                      : [
                          ...layout.pinned,
                          { path: pinPath, label: name.slice(0, 120) },
                        ],
                  })
                }
              >
                {pinned ? m.collections_view_unpin() : m.collections_view_pin()}
              </DropdownMenuItem>
            ) : null}
            {view.views.length > 1 ? (
              <DropdownMenuItem onClick={() => setDialog({ kind: 'order' })}>
                {m.collections_view_order()}
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() =>
                void view.resetPage().then((previous) => setUndo(previous))
              }
            >
              {m.collections_view_reset_page()}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <span className="sr-only" role="status">
        {copied ? m.collections_view_link_copied() : ''}
      </span>
      {exporting.isSuccess ? (
        <Alert role="status" className="collection-view-notice">
          {exporting.data.truncated
            ? m.collections_export_done_truncated({
                count: exporting.data.rows,
              })
            : m.collections_export_done({ count: exporting.data.rows })}
        </Alert>
      ) : exporting.isError ? (
        <Alert tone="danger" role="alert" className="collection-view-notice">
          {exporting.error instanceof IdentityError
            ? exporting.error.message
            : m.collections_export_failed()}
        </Alert>
      ) : null}
      {view.unavailable ? (
        <Alert role="status" className="collection-view-notice">
          {m.collections_view_unavailable()}{' '}
          <Button
            variant="outline"
            onClick={() => view.open(`builtin:${view.base.segment ?? 'all'}`)}
          >
            {m.collections_view_open_default()}
          </Button>
        </Alert>
      ) : null}
      {conflict && saved ? (
        <Alert role="alert" className="collection-view-notice">
          {m.collections_view_conflict()}{' '}
          <Button
            variant="outline"
            onClick={() => {
              setConflict(false);
              setDialog({ kind: 'save-as' });
            }}
          >
            {m.collections_view_save_as()}
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              setConflict(false);
              void invalidateCollection(queryClient, organizationId);
              view.reset();
            }}
          >
            {m.collections_view_discard_mine()}
          </Button>
        </Alert>
      ) : null}
      {undo ? (
        <Alert role="status" className="collection-view-notice">
          {m.collections_view_reset_done()}{' '}
          <Button
            variant="outline"
            onClick={() => {
              void view.restore(undo);
              setUndo(null);
            }}
          >
            {m.collections_undo()}
          </Button>
        </Alert>
      ) : null}
      {dialog?.kind === 'save-as' || dialog?.kind === 'rename' ? (
        <SaveViewDialog
          organizationId={organizationId}
          title={
            dialog.kind === 'rename'
              ? m.collections_view_rename_sharing()
              : m.collections_view_save_as()
          }
          initial={
            dialog.kind === 'rename' && saved
              ? { name: saved.name, sharing: saved.sharing }
              : {
                  name: saved
                    ? m.collections_view_copy_name({ name: saved.name })
                    : name,
                  sharing: { scope: 'private', roleIds: [] },
                }
          }
          currentSharing={dialog.kind === 'rename' ? saved?.sharing : undefined}
          canShare={permissions.can('adaptive.views.manage')}
          close={() => setDialog(null)}
          submit={async ({ name: nextName, sharing }) => {
            if (dialog.kind === 'rename' && saved) {
              await updateCollectionView(organizationId, saved, {
                name: nextName,
                sharing,
              });
              await invalidateCollection(queryClient, organizationId);
            } else {
              const created = await createCollectionView(organizationId, {
                name: nextName,
                sharing,
                query: query(view.state),
              });
              await invalidateCollection(queryClient, organizationId);
              view.open(created.id);
            }
            setDialog(null);
          }}
        />
      ) : null}
      {dialog?.kind === 'order' ? (
        <ViewOrderDialog
          items={view.views.map((item) => ({
            key: item.key,
            label: label(item),
          }))}
          close={() => setDialog(null)}
          save={(keys) => {
            view.setOrder(keys);
            setDialog(null);
          }}
        />
      ) : null}
      {dialog?.kind === 'archive' && saved ? (
        <Dialog open onOpenChange={(open) => !open && setDialog(null)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>
                {m.collections_view_archive_title({ name: saved.name })}
              </DialogTitle>
              <DialogDescription>
                {m.collections_view_archive_body()}
              </DialogDescription>
            </DialogHeader>
            {archive.isError ? (
              <Alert tone="danger" role="alert">
                {archive.error instanceof IdentityError
                  ? archive.error.message
                  : m.collections_view_save_failed()}
              </Alert>
            ) : null}
            <DialogFooter>
              <Button variant="ghost" onClick={() => setDialog(null)}>
                {m.common_cancel()}
              </Button>
              <Button
                variant="destructive"
                onClick={() => archive.mutate()}
                disabled={archive.isPending}
              >
                {m.collections_view_archive()}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  );
}

/**
 * Names a view and chooses who sees it. Members without view management keep views private;
 * for an existing view they may keep or narrow its sharing.
 */
function SaveViewDialog({
  organizationId,
  title,
  initial,
  currentSharing,
  canShare,
  close,
  submit,
}: {
  organizationId: string;
  title: string;
  initial: { name: string; sharing: Sharing };
  currentSharing?: Sharing | undefined;
  canShare: boolean;
  close: () => void;
  submit: (value: { name: string; sharing: Sharing }) => Promise<void>;
}) {
  const id = useId();
  const [name, setName] = useState(initial.name);
  const [sharing, setSharing] = useState<Sharing>(initial.sharing);
  const roles = useQuery({
    ...rolesOptions(organizationId),
    enabled: canShare,
  });
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const allowed = (scope: Sharing['scope']) =>
    scope === 'private' ||
    canShare ||
    (currentSharing !== undefined &&
      (currentSharing.scope === scope ||
        (currentSharing.scope === 'workspace' && scope === 'roles')));
  const roleChoices =
    roles.data?.roles ??
    (currentSharing?.roleIds ?? []).map((roleId) => ({
      id: roleId,
      name: roleId,
    }));

  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <DialogContent>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            setPending(true);
            setError(null);
            submit({ name: name.trim(), sharing }).catch((reason: unknown) => {
              setError(
                reason instanceof IdentityError
                  ? reason.message
                  : m.collections_view_save_failed(),
              );
              setPending(false);
            });
          }}
        >
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
          </DialogHeader>
          <Field>
            <FieldLabel htmlFor={`${id}-name`}>
              {m.collections_view_name()}
            </FieldLabel>
            <Input
              id={`${id}-name`}
              value={name}
              maxLength={120}
              required
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
          <fieldset className="collection-view-sharing">
            <legend>{m.collections_view_sharing()}</legend>
            {(['private', 'workspace', 'roles'] as const).map((scope) => (
              <label key={scope}>
                <input
                  type="radio"
                  name={`${id}-sharing`}
                  value={scope}
                  checked={sharing.scope === scope}
                  disabled={!allowed(scope)}
                  onChange={() =>
                    setSharing({
                      scope,
                      roleIds:
                        scope === 'roles'
                          ? (currentSharing?.roleIds ?? [])
                          : [],
                    })
                  }
                />
                {scope === 'private'
                  ? m.collections_view_sharing_private()
                  : scope === 'workspace'
                    ? m.collections_view_sharing_workspace()
                    : m.collections_view_sharing_roles()}
              </label>
            ))}
            {sharing.scope === 'roles' ? (
              <div className="collection-view-roles">
                {roleChoices.map((role) => (
                  <label key={role.id}>
                    <input
                      type="checkbox"
                      checked={sharing.roleIds.includes(role.id)}
                      disabled={
                        !canShare && !currentSharing?.roleIds.includes(role.id)
                      }
                      onChange={(event) =>
                        setSharing({
                          scope: 'roles',
                          roleIds: event.target.checked
                            ? [...sharing.roleIds, role.id]
                            : sharing.roleIds.filter(
                                (item) => item !== role.id,
                              ),
                        })
                      }
                    />
                    {role.name}
                  </label>
                ))}
              </div>
            ) : null}
            <FieldDescription>
              {m.collections_view_sharing_note()}
              {canShare
                ? ''
                : ` ${m.collections_view_sharing_requires_manage()}`}
            </FieldDescription>
          </fieldset>
          {error ? (
            <Alert tone="danger" role="alert">
              {error}
            </Alert>
          ) : null}
          <DialogFooter>
            <Button variant="ghost" type="button" onClick={close}>
              {m.common_cancel()}
            </Button>
            <Button
              type="submit"
              disabled={
                pending ||
                !name.trim() ||
                (sharing.scope === 'roles' && !sharing.roleIds.length)
              }
            >
              {m.collections_view_save()}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Lets the member order the view menu with move buttons; the order is their own. */
function ViewOrderDialog({
  items,
  close,
  save,
}: {
  items: readonly { key: string; label: string }[];
  close: () => void;
  save: (keys: string[]) => void;
}) {
  const [order, setOrder] = useState(() => items.map((item) => item.key));
  const [announcement, setAnnouncement] = useState('');
  const labelOf = (key: string) =>
    items.find((item) => item.key === key)?.label ?? key;
  const move = (index: number, offset: number) => {
    const next = [...order];
    const [moved] = next.splice(index, 1);
    if (moved === undefined) return;
    next.splice(index + offset, 0, moved);
    setOrder(next);
    setAnnouncement(
      m.collections_view_order_moved({
        view: labelOf(moved),
        position: index + offset + 1,
        count: next.length,
      }),
    );
  };

  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{m.collections_view_order()}</DialogTitle>
          <DialogDescription>
            {m.collections_view_order_note()}
          </DialogDescription>
        </DialogHeader>
        <ol className="collection-view-order">
          {order.map((key, index) => (
            <li key={key}>
              <span>{labelOf(key)}</span>
              <Button
                variant="ghost"
                size="icon"
                aria-label={m.collections_view_order_up({ view: labelOf(key) })}
                disabled={index === 0}
                onClick={() => move(index, -1)}
              >
                <ArrowUp aria-hidden="true" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label={m.collections_view_order_down({
                  view: labelOf(key),
                })}
                disabled={index === order.length - 1}
                onClick={() => move(index, 1)}
              >
                <ArrowDown aria-hidden="true" />
              </Button>
            </li>
          ))}
        </ol>
        <span className="sr-only" role="status">
          {announcement}
        </span>
        <DialogFooter>
          <Button variant="ghost" onClick={close}>
            {m.common_cancel()}
          </Button>
          <Button onClick={() => save(order)}>
            {m.collections_view_save()}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
