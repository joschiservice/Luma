import type {
  AutoLinkPreview,
  AutoLinkRule,
  SyncConnectionView,
} from '@luma/api-contract';
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

import { IdentityError } from '../identity/data';
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
}: {
  organizationId: string;
  connections: SyncConnectionView[];
  canManage: boolean;
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
        error={
          error ??
          (query.isError
            ? 'Automatic linking rules could not be loaded.'
            : null)
        }
        canManage={canManage}
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
}) {
  const label = (id: string) =>
    connections.find((connection) => connection.connectionId === id)?.label ??
    'Unavailable connection';

  return (
    <Card as="section" aria-labelledby="automatic-links-title">
      <CardHeader>
        <div>
          <CardTitle as="h2" id="automatic-links-title">
            Automatic linking
          </CardTitle>
          <CardDescription>
            Group matching SKUs and orders across selected connections. Each
            source keeps its own facts.
          </CardDescription>
        </div>
        {canManage ? (
          <Button
            variant="outline"
            onClick={add}
            disabled={busy || loading || !rules || connections.length < 2}
          >
            Add linking rule
          </Button>
        ) : null}
      </CardHeader>
      <CardContent>
        {error ? (
          <Alert tone="danger" role="alert">
            {error}{' '}
            <Button variant="outline" size="sm" onClick={retry}>
              Retry
            </Button>
          </Alert>
        ) : null}
        {loading ? (
          <p role="status">Loading linking rules…</p>
        ) : rules?.length ? (
          <ul className="auto-link-rules">
            {rules.map((rule) => (
              <li key={rule.id}>
                <div>
                  <strong>
                    {rule.kind === 'sku'
                      ? 'Unique SKU code'
                      : 'JTL order reference'}
                  </strong>
                  <p>
                    {label(rule.sourceConnectionId)} →{' '}
                    {label(rule.targetConnectionId)}
                  </p>
                  <p>
                    {rule.linked.toLocaleString()}{' '}
                    {rule.linked === 1 ? 'link' : 'links'} applied
                    {rule.lastCheckedAt ? (
                      <>
                        {' '}
                        · Checked <WorkspaceDate value={rule.lastCheckedAt} />
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
                    ? 'Enabled'
                    : rule.state === 'disabled'
                      ? 'Disabled'
                      : rule.state === 'blocked'
                        ? 'Needs access'
                        : rule.state === 'failed'
                          ? 'Retrying'
                          : 'Waiting for reads'}
                </StatePill>
                {canManage ? (
                  <div className="auto-link-actions">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() => edit(rule)}
                    >
                      Preview
                      {!rule.enabled || rule.state === 'blocked'
                        ? ' and enable'
                        : ''}
                    </Button>
                    {rule.enabled ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        onClick={() => disable(rule)}
                      >
                        Disable
                      </Button>
                    ) : null}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        ) : rules ? (
          <p>
            No automatic linking rules. Matching records stay separate until you
            link them or enable a rule.
          </p>
        ) : null}
        <p>
          <a href="/docs/data-sync#automatic-linking">
            How automatic linking works
          </a>
        </p>
      </CardContent>
    </Card>
  );
}

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
          connection.provider === (side === 'target' ? 'shopify' : 'jtl'),
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
        {existing ? 'Review linking rule' : 'Add linking rule'}
      </DialogTitle>
      <DialogDescription>
        Preview current matches, then enable ongoing linking with your access.
        Disabling a rule keeps the links already applied.
      </DialogDescription>
      <div className="auto-link-fields">
        <Select
          aria-label="Record type"
          disabled={!!existing || busy}
          value={kind}
          options={[
            { value: 'sku', label: 'SKUs: unique code' },
            { value: 'order', label: 'Orders: JTL reference to Shopify' },
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
          aria-label={kind === 'order' ? 'Shopify store' : 'Link to connection'}
          disabled={!!existing || busy}
          value={target || null}
          options={options('target')}
          placeholder={
            kind === 'order' ? 'Shopify store' : 'Link to connection'
          }
          onValueChange={(value) => {
            form.setFieldValue('target', value ?? '');
            setPreview(null);
          }}
        />
        <Select
          aria-label={kind === 'order' ? 'JTL connection' : 'Other connection'}
          disabled={!!existing || busy}
          value={source || null}
          options={options('source')}
          placeholder={kind === 'order' ? 'JTL connection' : 'Other connection'}
          onValueChange={(value) => {
            form.setFieldValue('source', value ?? '');
            setPreview(null);
          }}
        />
      </div>
      <p>
        {kind === 'sku'
          ? 'SKU matching ignores letter case and surrounding spaces. Codes must be unique in both connections, with matching units.'
          : 'The JTL external order reference must uniquely match the order number in this Shopify store. Dates, totals and customer details do not establish identity.'}{' '}
        Manually separated records are skipped.
      </p>
      {error ? (
        <Alert tone="danger" role="alert">
          {error}
        </Alert>
      ) : null}
      {busy ? (
        <p role="status">{preview ? 'Saving rule…' : 'Checking matches…'}</p>
      ) : null}
      {preview ? (
        <div aria-live="polite">
          {preview.ready ? (
            <>
              <p>
                <strong>
                  {preview.counts.eligible.toLocaleString()}{' '}
                  {preview.counts.eligible === 1 ? 'match can' : 'matches can'}{' '}
                  be linked
                </strong>
              </p>
              <p>
                {preview.counts.ambiguous} ambiguous · {preview.counts.conflict}{' '}
                conflicting · {preview.counts.excluded} manually separated or
                awaiting review · {preview.counts.stale} with stale or missing
                evidence
              </p>
              <ul className="auto-link-examples">
                {preview.candidates.map((candidate) => (
                  <li key={candidate.key}>
                    <strong>{candidate.key}</strong> ·{' '}
                    {candidate.disposition === 'eligible'
                      ? 'Can link'
                      : {
                          ambiguous: 'Ambiguous match',
                          conflict: 'Conflicting records',
                          excluded: 'Manual review',
                          stale: 'Stale evidence',
                        }[candidate.disposition]}{' '}
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
                      First record
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
                      Other record
                    </Link>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <Alert tone="warning">{preview.message}</Alert>
          )}
          <p>
            Future matches are checked again before linking. Sources keep their
            own quantities, prices and order states.
          </p>
        </div>
      ) : null}
      <div className="sync-dialog-actions">
        <Button variant="outline" onClick={close} disabled={busy}>
          Cancel
        </Button>
        <Button
          variant="outline"
          onClick={() => void submit(false)}
          disabled={busy || !target || !source || target === source}
        >
          Preview matches
        </Button>
        {preview ? (
          <Button onClick={() => void submit(true)} disabled={busy}>
            Enable automatic linking
          </Button>
        ) : null}
      </div>
    </DialogContent>
  );
}

function saveError(error: unknown) {
  if (error instanceof IdentityError && error.status === 403)
    return 'Your role no longer includes Manage imports.';
  if (error instanceof IdentityError && error.status === 409)
    return 'This rule changed or already exists. Close this dialog and refresh before trying again.';

  return 'Luma could not update automatic linking. Try again.';
}
