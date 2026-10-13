import { m } from '@luma/i18n/messages';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Badge } from '@luma/ui/components/primitives/badge';
import { Button } from '@luma/ui/components/primitives/button';
import { DataTable } from '@luma/ui/components/primitives/data-table';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@luma/ui/components/primitives/dialog';
import { Select } from '@luma/ui/components/primitives/select';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { adaptiveApi, adaptiveKey } from './data';
import { adaptiveLabel } from './presentation';

/** Reviews each selected record and sends only the unchanged review to governed proposal creation. */
export function AdaptiveActions({
  organizationId,
  viewId,
  recordIds,
}: {
  organizationId: string;
  viewId: string;
  recordIds: string[];
}) {
  const catalog = useQuery({
    queryKey: [...adaptiveKey(organizationId), 'actions', viewId],
    queryFn: ({ signal }) =>
      adaptiveApi.adaptiveActions.catalog(
        { params: { organizationId, viewId } },
        { signal },
      ),
  });
  const [actionId, setActionId] = useState<string | null>(null);
  const [request, setRequest] = useState<{
    commandId: string;
    recordIds: string[];
  } | null>(null);
  const [open, setOpen] = useState(false);
  const preview = useMutation({
    mutationFn: (body: { commandId: string; recordIds: string[] }) => {
      if (!actionId) throw new Error('Action unavailable');

      return adaptiveApi.adaptiveActions.preview({
        params: { organizationId, viewId, actionId },
        body,
      });
    },
  });
  const run = useMutation({
    mutationFn: () => {
      if (!actionId || !request || !preview.data)
        throw new Error('Review unavailable');

      return adaptiveApi.adaptiveActions.run({
        params: { organizationId, viewId, actionId },
        body: { ...request, reviewDigest: preview.data.reviewDigest },
      });
    },
  });
  if (!catalog.data?.items.length)
    return catalog.isError ? (
      <Alert tone="warning">{m.adaptive_load_failed()}</Alert>
    ) : null;

  return (
    <>
      <div className="adaptive-actions">
        <Select
          aria-label={m.adaptive_actions()}
          value={actionId}
          placeholder={m.adaptive_actions()}
          options={catalog.data.items.map((action) => ({
            value: action.id,
            label: adaptiveLabel(action.label),
            disabled: !action.available,
          }))}
          onValueChange={(value) => {
            setActionId(value);
            preview.reset();
            run.reset();
            setRequest(null);
          }}
        />
        <Button
          variant="outline"
          disabled={!actionId || !recordIds.length || preview.isPending}
          onClick={() => {
            const next = {
              commandId: crypto.randomUUID(),
              recordIds: [...recordIds],
            };
            setRequest(next);
            run.reset();
            setOpen(true);
            preview.mutate(next);
          }}
        >
          {m.adaptive_action_preview()}
        </Button>
        <span>{m.adaptive_selected({ count: recordIds.length })}</span>
      </div>
      <Dialog
        open={open}
        onOpenChange={(value) => {
          if (!run.isPending) setOpen(value);
        }}
      >
        <DialogContent className="adaptive-dialog">
          <DialogHeader>
            <DialogTitle>{m.adaptive_action_preview()}</DialogTitle>
            <DialogDescription>{m.adaptive_action_note()}</DialogDescription>
          </DialogHeader>
          {preview.isPending ? (
            <Alert role="status">{m.adaptive_loading()}</Alert>
          ) : preview.isError ? (
            <Alert tone="warning" role="alert">
              {m.adaptive_load_failed()}
            </Alert>
          ) : preview.data && !run.data ? (
            <>
              <div className="adaptive-review-list">
                {preview.data.items.map((item) => (
                  <section key={item.recordId}>
                    <h3>{item.recordId}</h3>
                    {!item.available ? (
                      <Alert tone="warning">
                        {item.reason ?? m.adaptive_unavailable()}
                      </Alert>
                    ) : null}
                    <dl>
                      <dt>{m.adaptive_permissions()}</dt>
                      <dd>{item.scope}</dd>
                      <dt>{m.settings_section_approvals()}</dt>
                      <dd>{item.approval}</dd>
                      <dt>{m.adaptive_result()}</dt>
                      <dd>{item.verification}</dd>
                    </dl>
                    {item.changes.map((change) => (
                      <p key={change.label}>
                        <strong>{change.label}</strong>:{' '}
                        {change.before ?? m.adaptive_not_set()} →{' '}
                        {change.after ?? m.adaptive_not_set()}
                      </p>
                    ))}
                  </section>
                ))}
              </div>
              <Button
                disabled={
                  run.isPending ||
                  !preview.data.items.some((item) => item.available)
                }
                onClick={() => run.mutate()}
              >
                {m.adaptive_action_run()}
              </Button>
            </>
          ) : null}
          {run.isError ? (
            <Alert tone="warning" role="alert">
              {m.adaptive_operation_failed()}
            </Alert>
          ) : null}
          {run.data ? (
            <DataTable
              caption={m.adaptive_result()}
              rows={run.data.items}
              rowKey={(item) => item.recordId}
              columns={[
                {
                  key: 'record',
                  header: m.adaptive_domain(),
                  cell: (item) => item.recordId,
                },
                {
                  key: 'result',
                  header: m.adaptive_result(),
                  cell: (item) => (
                    <>
                      <Badge
                        tone={
                          item.state === 'failed' || item.state === 'uncertain'
                            ? 'warning'
                            : item.state === 'verified'
                              ? 'success'
                              : 'neutral'
                        }
                      >
                        {{
                          proposed: m.adaptive_action_proposed,
                          approval_required:
                            m.adaptive_action_approval_required,
                          verified: m.adaptive_action_verified,
                          uncertain: m.adaptive_action_uncertain,
                          failed: m.adaptive_action_failed,
                          unavailable: m.adaptive_action_unavailable,
                        }[item.state]()}
                      </Badge>
                      {item.reason ? <p>{item.reason}</p> : null}
                      {item.destination &&
                      !/[\\%?#]/.test(item.destination) &&
                      !item.destination.startsWith('/') &&
                      !item.destination.includes('..') ? (
                        <a
                          href={`/app/${encodeURIComponent(organizationId)}/${item.destination}`}
                        >
                          {m.adaptive_review_proposal()}
                        </a>
                      ) : null}
                    </>
                  ),
                },
              ]}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
