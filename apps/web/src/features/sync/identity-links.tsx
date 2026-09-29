import './sync.css';

import type { IdentityDetail, LinkInput } from '@luma/api-contract';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Badge } from '@luma/ui/components/primitives/badge';
import { Button } from '@luma/ui/components/primitives/button';
import { Card } from '@luma/ui/components/primitives/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@luma/ui/components/primitives/dialog';
import { Textarea } from '@luma/ui/components/primitives/textarea';
import { WorkspaceDate } from '@luma/ui/components/primitives/workspace-date';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link2, Unlink } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { IdentityError } from '../identity/data';
import { identityKey, identityOptions, requestLink } from './data';
import { providerName, sourceId } from './presentation';

type Source = IdentityDetail['sources'][number];

type Pending =
  | { operation: 'link'; otherId: string; label: string; reason: string }
  | { operation: 'unlink'; source: Source };

/**
 * Loads the source records behind a SKU and lets owners and admins confirm matches in other
 * sources or separate a source again. Refreshes `onChanged` data once a request completes.
 */
export function IdentityLinks({
  organizationId,
  entityId,
  onChanged,
}: {
  organizationId: string;
  entityId: string;
  onChanged: () => void;
}) {
  const query = useQuery(identityOptions(organizationId, 'sku', entityId));
  const client = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  // Requests sent from this view; stock data refreshes when one completes.
  const watching = useRef(new Set<string>());
  useEffect(() => {
    for (const request of query.data?.requests ?? [])
      if (request.state === 'completed' && watching.current.delete(request.id))
        onChanged();
  }, [query.data, onChanged]);

  async function submit(input: LinkInput) {
    setError(null);
    try {
      const request = await requestLink(organizationId, input);
      watching.current.add(request.id);
      await client.invalidateQueries({
        queryKey: identityKey(organizationId, 'sku', entityId),
      });
    } catch (cause) {
      setError(
        cause instanceof IdentityError && cause.message
          ? cause.message
          : 'Luma could not send this request. Try again.',
      );
    }
  }

  if (query.isPending)
    return (
      <Card className="inventory-section">
        <h2>Linked sources</h2>
        <p role="status" className="inventory-note">
          Loading linked sources…
        </p>
      </Card>
    );
  if (!query.data) return null;

  return (
    <IdentityLinksView
      detail={query.data}
      error={error}
      submit={(input) => void submit(input)}
    />
  );
}

/** Presents a SKU's source records, suggested matches and the latest link request. */
export function IdentityLinksView({
  detail,
  error = null,
  submit,
}: {
  detail: IdentityDetail;
  error?: string | null;
  submit: (input: LinkInput) => void;
}) {
  const [pending, setPending] = useState<Pending | null>(null);
  const [reason, setReason] = useState('');
  const latest = detail.requests[0];
  const busy = latest?.state === 'requested' || latest?.state === 'running';
  const open = (next: Pending) => {
    setPending(next);
    setReason(next.operation === 'link' ? next.reason : '');
  };

  return (
    <Card className="inventory-section sync-identity" as="section">
      <h2>Linked sources</h2>
      <p className="inventory-note">
        Each source keeps its own ID. Luma treats records from different sources
        as the same SKU only after a person links them.
      </p>
      <ul className="sync-identity-sources">
        {detail.sources.map((source) => (
          <li key={`${source.connectionId}:${source.externalId}`}>
            <span className="sync-identity-source">
              <strong>{source.connectionLabel}</strong>
              <small>
                <span title={source.externalId}>
                  {providerName(source.provider)} ID{' '}
                  {sourceId(source.externalId)}
                </span>
                {source.codes.length ? ` · SKU ${source.codes.join(', ')}` : ''}
                {source.titles.length ? ` · ${source.titles[0]}` : ''}
              </small>
            </span>
            <Badge tone={source.revisedAt ? 'info' : 'neutral'}>
              {source.method.startsWith('Linked')
                ? 'Linked by a person'
                : source.method.startsWith('Unlinked')
                  ? 'Unlinked'
                  : source.method.startsWith('Imported')
                    ? 'Imported'
                    : 'Mapped'}
            </Badge>
            {detail.canManage && detail.sources.length > 1 ? (
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => open({ operation: 'unlink', source })}
              >
                <Unlink aria-hidden="true" /> Unlink
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
      {detail.suggestions.length ? (
        <div className="sync-identity-suggestions">
          <h3>Possibly the same SKU</h3>
          <ul className="sync-identity-sources">
            {detail.suggestions.map((suggestion) => (
              <li key={suggestion.id}>
                <span className="sync-identity-source">
                  <strong>{suggestion.label}</strong>
                  <small>
                    {suggestion.reason} ·{' '}
                    {suggestion.sources
                      .map((source) => source.connectionLabel)
                      .join(', ')}
                  </small>
                </span>
                {detail.canManage ? (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() =>
                      open({
                        operation: 'link',
                        otherId: suggestion.id,
                        label: suggestion.label,
                        reason: `${suggestion.reason}; confirmed as the same item`,
                      })
                    }
                  >
                    <Link2 aria-hidden="true" /> Link
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {latest ? (
        latest.state === 'failed' ? (
          <Alert tone="danger" role="alert">
            {latest.message ?? 'The last request failed.'}
          </Alert>
        ) : busy ? (
          <Alert role="status">
            {latest.operation === 'link' ? 'Linking' : 'Unlinking'} records.
            Luma is regrouping stock, products and order lines.
          </Alert>
        ) : (
          <p className="inventory-note">
            Last change: {latest.operation === 'link' ? 'linked' : 'unlinked'}{' '}
            <WorkspaceDate value={latest.completedAt ?? latest.createdAt} />.
          </p>
        )
      ) : null}
      {error ? (
        <Alert tone="danger" role="alert">
          {error}
        </Alert>
      ) : null}
      <Dialog
        open={pending !== null}
        onOpenChange={(value) => (value ? null : setPending(null))}
      >
        <DialogContent>
          <DialogTitle>
            {pending?.operation === 'link'
              ? `Link ${pending.label} to ${detail.entity.label}?`
              : `Unlink ${pending?.operation === 'unlink' ? pending.source.connectionLabel : ''}?`}
          </DialogTitle>
          <DialogDescription>
            {pending?.operation === 'link'
              ? 'Luma will treat both records as one SKU: stock, products and order lines from each source are grouped here, while each source keeps its own quantities. You can unlink later; the change is recorded.'
              : 'This source becomes its own SKU again. Its stock, products and order lines move with it. The change is recorded.'}
          </DialogDescription>
          <label className="sync-identity-reason">
            <span>Why is this correct?</span>
            <Textarea
              value={reason}
              maxLength={2000}
              onChange={(event) => setReason(event.target.value)}
            />
          </label>
          <div className="sync-dialog-actions">
            <Button variant="outline" onClick={() => setPending(null)}>
              Cancel
            </Button>
            <Button
              disabled={!reason.trim()}
              onClick={() => {
                if (!pending) return;
                submit(
                  pending.operation === 'link'
                    ? {
                        operation: 'link',
                        kind: 'sku',
                        entityId: detail.entity.id,
                        otherId: pending.otherId,
                        reason: reason.trim(),
                      }
                    : {
                        operation: 'unlink',
                        kind: 'sku',
                        entityId: detail.entity.id,
                        connectionId: pending.source.connectionId,
                        reason: reason.trim(),
                      },
                );
                setPending(null);
              }}
            >
              {pending?.operation === 'link' ? 'Link records' : 'Unlink source'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
