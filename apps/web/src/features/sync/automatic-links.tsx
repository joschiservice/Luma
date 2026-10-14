import type {
  AutoLinkPreview,
  AutoLinkRule,
  SyncConnectionView,
} from '@luma/api-contract';
import { formatNumber } from '@luma/i18n/format';
import { m } from '@luma/i18n/messages';
import { rich } from '@luma/i18n/rich';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Button } from '@luma/ui/components/primitives/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@luma/ui/components/primitives/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@luma/ui/components/primitives/dialog';
import { Select } from '@luma/ui/components/primitives/select';
import { StatePill } from '@luma/ui/components/primitives/state';
import { WorkspaceDate } from '@luma/ui/components/primitives/workspace-date';
import { useForm, useStore } from '@tanstack/react-form';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useRef, useState } from 'react';

import { IdentityError } from '../../kit/identity/data';
import {
  autoLinkOptions,
  previewAutoLinks,
  saveAutoLinkRule,
  syncKey,
} from './data';

/** Loads automatic link configuration separately from the live sync overview. */
export function AutomaticLinks({
  organizationId,
  connections,
  canManage,
  coverage,
}: {
  organizationId: string;
  connections: SyncConnectionView[];
  canManage: boolean;
  coverage?:
    Record<'sku' | 'order', { total: number; linked: number }> | undefined;
}) {
  const query = useQuery(autoLinkOptions(organizationId));
  const client = useQueryClient();
  const [editing, setEditing] = useState<{ rule?: AutoLinkRule } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lock = useRef(false);

  async function disable(rule: AutoLinkRule) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    try {
      await saveAutoLinkRule(organizationId, {
        id: rule.id,
        revision: rule.revision,
        kind: rule.kind,
        targetConnectionId: rule.targetConnectionId,
        sourceConnectionId: rule.sourceConnectionId,
        enabled: false,
      });
      await client.invalidateQueries({ queryKey: syncKey(organizationId) });
    } catch (error) {
      setError(saveError(error));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  return (
    <>
      <AutomaticLinksView
        connections={connections}
        rules={query.data}
        loading={query.isPending}
        error={error ?? (query.isError ? m.sync_autolink_load_failed() : null)}
        canManage={canManage}
        coverage={coverage}
        busy={busy}
        retry={() => void query.refetch()}
        add={() => setEditing({})}
        edit={(rule) => setEditing({ rule })}
        disable={(rule) => void disable(rule)}
      />
      <Dialog
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
      >
        {editing ? (
          <RuleEditor
            key={editing.rule?.id ?? 'new'}
            organizationId={organizationId}
            connections={connections}
            existing={editing.rule}
            close={() => setEditing(null)}
            saved={async () => {
              await client.invalidateQueries({
                queryKey: syncKey(organizationId),
              });
              setEditing(null);
            }}
          />
        ) : null}
      </Dialog>
    </>
  );
}

/** Presents rule outcomes without treating automatic identity links as verified stock or order outcomes. */
export function AutomaticLinksView({
  connections,
  rules,
  loading,
  error,
  canManage,
  busy = false,
  add,
  edit,
  disable,
  retry,
  coverage,
}: {
  connections: SyncConnectionView[];
  rules?: AutoLinkRule[] | undefined;
  loading: boolean;
  error: string | null;
  canManage: boolean;
  busy?: boolean;
  add: () => void;
  edit: (rule: AutoLinkRule) => void;
  disable: (rule: AutoLinkRule) => void;
  retry: () => void;
  coverage?:
    Record<'sku' | 'order', { total: number; linked: number }> | undefined;
}) {
  const label = (id: string) =>
    connections.find((connection) => connection.connectionId === id)?.label ??
    m.sync_autolink_unavailable_connection();

  return (
    <Card as="section" aria-labelledby="automatic-links-title">
      <CardHeader>
        <div>
          <CardTitle as="h2" id="automatic-links-title">
            {m.sync_autolink_title()}
          </CardTitle>
          <CardDescription>{m.sync_autolink_description()}</CardDescription>
        </div>
        {canManage ? (
          <Button
            variant="outline"
            onClick={add}
            disabled={busy || loading || !rules || connections.length < 2}
          >
            {m.sync_autolink_add()}
          </Button>
        ) : null}
      </CardHeader>
      <CardContent>
        {coverage ? (
          <div>
            <p>
              {m.sync_link_coverage_sku({
                linked: formatNumber(coverage.sku.linked),
                total: formatNumber(coverage.sku.total),
              })}
            </p>
            <p>
              {m.sync_link_coverage_order({
                linked: formatNumber(coverage.order.linked),
                total: formatNumber(coverage.order.total),
              })}
            </p>
            <p>{m.sync_link_coverage_monitoring()}</p>
          </div>
        ) : null}
        {error ? (
          <Alert tone="danger" role="alert">
            {error}{' '}
            <Button variant="outline" size="sm" onClick={retry}>
              {m.common_retry()}
            </Button>
          </Alert>
        ) : null}
        {loading ? (
          <p role="status">{m.sync_autolink_loading()}</p>
        ) : rules?.length ? (
          <ul className="auto-link-rules">
            {rules.map((rule) => (
              <li key={rule.id}>
                <div>
                  <strong>
                    {rule.kind === 'sku'
                      ? m.sync_autolink_kind_sku()
                      : m.sync_autolink_kind_order()}
                  </strong>
                  <p>
                    {m.sync_autolink_pair({
                      source: label(rule.sourceConnectionId),
                      target: label(rule.targetConnectionId),
                    })}
                  </p>
                  <p>
                    {m.sync_autolink_applied({ count: rule.linked })}
                    {rule.lastCheckedAt ? (
                      <>
                        {' · '}
                        {rich(m.sync_autolink_checked, {
                          date: <WorkspaceDate value={rule.lastCheckedAt} />,
                        })}
                      </>
                    ) : null}
                  </p>
                  {rule.message ? <p>{rule.message}</p> : null}
                </div>
                <StatePill
                  state={
                    rule.state === 'active'
                      ? 'idle'
                      : rule.state === 'failed'
                        ? 'error'
                        : rule.state === 'disabled'
                          ? 'idle'
                          : 'attention'
                  }
                >
                  {rule.state === 'active'
                    ? m.sync_autolink_state_active()
                    : rule.state === 'disabled'
                      ? m.sync_autolink_state_disabled()
                      : rule.state === 'blocked'
                        ? m.sync_autolink_state_blocked()
                        : rule.state === 'failed'
                          ? m.sync_autolink_state_failed()
                          : m.sync_autolink_state_waiting()}
                </StatePill>
                {canManage ? (
                  <div className="auto-link-actions">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() => edit(rule)}
                    >
                      {!rule.enabled || rule.state === 'blocked'
                        ? m.sync_autolink_preview_and_enable()
                        : m.sync_autolink_preview()}
                    </Button>
                    {rule.enabled ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        onClick={() => disable(rule)}
                      >
                        {m.sync_autolink_disable()}
                      </Button>
                    ) : null}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        ) : rules ? (
          <p>{m.sync_autolink_empty()}</p>
        ) : null}
        <p>
          <a href="/docs/data-sync#automatic-linking">
            {m.sync_autolink_help_link()}
          </a>
        </p>
      </CardContent>
    </Card>
  );
}

const dispositions: Record<
  AutoLinkPreview['candidates'][number]['disposition'],
  () => string
> = {
  eligible: m.sync_autolink_disposition_eligible,
  ambiguous: m.sync_autolink_disposition_ambiguous,
  conflict: m.sync_autolink_disposition_conflict,
  excluded: m.sync_autolink_disposition_excluded,
  stale: m.sync_autolink_disposition_stale,
};

function RuleEditor({
  organizationId,
  connections,
  existing,
  close,
  saved,
}: {
  organizationId: string;
  connections: SyncConnectionView[];
  existing?: AutoLinkRule | undefined;
  close: () => void;
  saved: () => Promise<void>;
}) {
  const form = useForm({
    defaultValues: {
      kind: existing?.kind ?? 'sku',
      target: existing?.targetConnectionId ?? '',
      source: existing?.sourceConnectionId ?? '',
    },
  });
  const { kind, target, source } = useStore(
    form.store,
    (state) => state.values,
  );
  const [preview, setPreview] = useState<AutoLinkPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = useRef(existing?.id ?? crypto.randomUUID());
  const lock = useRef(false);
  const options = (side: 'target' | 'source') =>
    connections
      .filter(
        (connection) =>
          kind === 'sku' ||
          (side === 'target') === (connection.provider === 'shopify'),
      )
      .map((connection) => ({
        value: connection.connectionId,
        label: connection.label,
        disabled:
          connection.connectionId === (side === 'target' ? source : target),
      }));

  async function submit(enable: boolean) {
    if (!target || !source || lock.current) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    try {
      const pair = {
        kind,
        targetConnectionId: target,
        sourceConnectionId: source,
      };
      if (enable) {
        await saveAutoLinkRule(organizationId, {
          ...pair,
          id: id.current,
          revision: existing?.revision ?? 0,
          enabled: true,
        });
        await saved();
      } else setPreview(await previewAutoLinks(organizationId, pair));
    } catch (error) {
      setError(saveError(error));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  return (
    <DialogContent className="auto-link-editor">
      <DialogTitle>
        {existing ? m.sync_autolink_review_title() : m.sync_autolink_add()}
      </DialogTitle>
      <DialogDescription>
        {m.sync_autolink_editor_description()}
      </DialogDescription>
      <div className="auto-link-fields">
        <Select
          aria-label={m.sync_autolink_record_type()}
          disabled={!!existing || busy}
          value={kind}
          options={[
            { value: 'sku', label: m.sync_autolink_option_sku() },
            { value: 'order', label: m.sync_autolink_option_order() },
          ]}
          onValueChange={(value) => {
            if (value) {
              form.setFieldValue('kind', value);
              form.setFieldValue('target', '');
              form.setFieldValue('source', '');
              setPreview(null);
            }
          }}
        />
        <Select
          aria-label={
            kind === 'order'
              ? m.sync_autolink_shopify_store()
              : m.sync_autolink_target_connection()
          }
          disabled={!!existing || busy}
          value={target || null}
          options={options('target')}
          placeholder={
            kind === 'order'
              ? m.sync_autolink_shopify_store()
              : m.sync_autolink_target_connection()
          }
          onValueChange={(value) => {
            form.setFieldValue('target', value ?? '');
            setPreview(null);
          }}
        />
        <Select
          aria-label={
            kind === 'order'
              ? m.sync_autolink_erp_connection()
              : m.sync_autolink_source_connection()
          }
          disabled={!!existing || busy}
          value={source || null}
          options={options('source')}
          placeholder={
            kind === 'order'
              ? m.sync_autolink_erp_connection()
              : m.sync_autolink_source_connection()
          }
          onValueChange={(value) => {
            form.setFieldValue('source', value ?? '');
            setPreview(null);
          }}
        />
      </div>
      <p>
        {kind === 'sku'
          ? m.sync_autolink_rule_sku()
          : m.sync_autolink_rule_order()}
      </p>
      {error ? (
        <Alert tone="danger" role="alert">
          {error}
        </Alert>
      ) : null}
      {busy ? (
        <p role="status">
          {preview ? m.sync_autolink_saving() : m.sync_autolink_checking()}
        </p>
      ) : null}
      {preview ? (
        <div aria-live="polite">
          {preview.ready ? (
            <>
              <p>
                <strong>
                  {m.sync_autolink_preview_eligible({
                    count: preview.counts.eligible,
                  })}
                </strong>
              </p>
              <p>
                {m.sync_autolink_preview_skipped({
                  ambiguous: preview.counts.ambiguous,
                  conflict: preview.counts.conflict,
                  excluded: preview.counts.excluded,
                  stale: preview.counts.stale,
                })}
              </p>
              <ul className="auto-link-examples">
                {preview.candidates.map((candidate) => (
                  <li key={candidate.key}>
                    <strong>{candidate.key}</strong> ·{' '}
                    {dispositions[candidate.disposition]()}{' '}
                    <Link
                      to={
                        kind === 'sku'
                          ? '/app/$organizationId/products/$skuId'
                          : '/app/$organizationId/orders/$orderId'
                      }
                      params={
                        kind === 'sku'
                          ? { organizationId, skuId: candidate.targetId }
                          : { organizationId, orderId: candidate.targetId }
                      }
                    >
                      {m.sync_autolink_first_record()}
                    </Link>
                    {' · '}
                    <Link
                      to={
                        kind === 'sku'
                          ? '/app/$organizationId/products/$skuId'
                          : '/app/$organizationId/orders/$orderId'
                      }
                      params={
                        kind === 'sku'
                          ? { organizationId, skuId: candidate.sourceId }
                          : { organizationId, orderId: candidate.sourceId }
                      }
                    >
                      {m.sync_autolink_other_record()}
                    </Link>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <Alert tone="warning">{preview.message}</Alert>
          )}
          <p>{m.sync_autolink_preview_note()}</p>
        </div>
      ) : null}
      <div className="sync-dialog-actions">
        <Button variant="outline" onClick={close} disabled={busy}>
          {m.common_cancel()}
        </Button>
        <Button
          variant="outline"
          onClick={() => void submit(false)}
          disabled={busy || !target || !source || target === source}
        >
          {m.sync_autolink_preview_matches()}
        </Button>
        {preview ? (
          <Button onClick={() => void submit(true)} disabled={busy}>
            {m.sync_autolink_enable()}
          </Button>
        ) : null}
      </div>
    </DialogContent>
  );
}

function saveError(error: unknown) {
  if (error instanceof IdentityError && error.status === 403)
    return m.sync_autolink_error_role();
  if (error instanceof IdentityError && error.status === 409)
    return m.sync_autolink_error_conflict();

  return m.sync_autolink_error_save();
}
