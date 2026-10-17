import './delivery-decision.css';

import type { Outbound } from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Button } from '@luma/ui/components/primitives/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '@luma/ui/components/primitives/dialog';
import { Textarea } from '@luma/ui/components/primitives/textarea';
import { WorkspaceDate } from '@luma/ui/components/primitives/workspace-date';
import { useMutation } from '@tanstack/react-query';
import { useId, useState } from 'react';

type Outcome = 'delivered' | 'not_delivered';

/** What a person decided about an uncertain supplier email, sent with a stable command ID. */
export interface DeliveryDecisionBody {
  id: string;
  expectedRevision: number;
  outcome: Outcome;
  note: string | null;
}

/**
 * Shows delivery evidence for a supplier email: an unverified delivery report's claims, how
 * uncertain delivery was settled, and, for people who may decide, the two delivery actions with
 * a confirmation and an optional internal note. The caller sends the decision and refreshes.
 */
export function DeliveryDecision({
  outbound,
  name,
  resolve,
  errorText,
  isUncertain,
  onResolved,
}: {
  outbound: Pick<
    Outbound,
    'state' | 'delivery' | 'canResolveDelivery' | 'revision'
  >;
  /** Names a member for display. */
  name: (id: string) => string;
  resolve: (body: DeliveryDecisionBody) => Promise<unknown>;
  errorText: (error: unknown) => string;
  /** Whether the request may have been applied, so the same request is retried. */
  isUncertain: (error: unknown) => boolean;
  onResolved: () => void;
}) {
  const [asking, setAsking] = useState<Outcome | null>(null);
  const { report, resolution } = outbound.delivery;
  const settled =
    resolution &&
    ((resolution.outcome === 'delivered' && outbound.state === 'sent') ||
      (resolution.outcome === 'not_delivered' && outbound.state === 'failed'))
      ? resolution
      : null;

  return (
    <div className="delivery-decision">
      {report && outbound.state === 'uncertain' ? (
        <>
          <p>
            {m.messaging_delivery_report({
              recipient: report.recipient,
              status: report.status,
            })}
          </p>
          <dl className="delivery-decision-facts">
            <div>
              <dt>{m.messaging_delivery_report_recipient()}</dt>
              <dd>{report.recipient}</dd>
            </div>
            <div>
              <dt>{m.messaging_delivery_report_status()}</dt>
              <dd>{report.status}</dd>
            </div>
          </dl>
        </>
      ) : null}
      {settled ? (
        <p role="status">
          {settled.source === 'reply'
            ? m.messaging_delivery_resolved_reply()
            : settled.outcome === 'delivered'
              ? m.messaging_delivery_resolved_delivered({
                  name: settled.by ? name(settled.by) : '',
                })
              : m.messaging_delivery_resolved_not_delivered({
                  name: settled.by ? name(settled.by) : '',
                })}{' '}
          · <WorkspaceDate value={settled.at} />
          {settled.note ? (
            <>
              <br />
              {m.messaging_delivery_resolved_note({ note: settled.note })}
            </>
          ) : null}
        </p>
      ) : null}
      {outbound.state === 'uncertain' && outbound.canResolveDelivery ? (
        <>
          <p>{m.messaging_delivery_question()}</p>
          <div
            className="delivery-decision-actions"
            role="group"
            aria-label={m.messaging_delivery_actions()}
          >
            <Button
              size="sm"
              variant="outline"
              onClick={() => setAsking('delivered')}
            >
              {m.messaging_delivery_mark_delivered()}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setAsking('not_delivered')}
            >
              {m.messaging_delivery_mark_not_delivered()}
            </Button>
          </div>
        </>
      ) : null}
      {asking ? (
        <DeliveryDialog
          outcome={asking}
          revision={outbound.revision}
          resolve={resolve}
          errorText={errorText}
          isUncertain={isUncertain}
          close={() => setAsking(null)}
          onResolved={() => {
            setAsking(null);
            onResolved();
          }}
        />
      ) : null}
    </div>
  );
}

function DeliveryDialog({
  outcome,
  revision,
  resolve,
  errorText,
  isUncertain,
  close,
  onResolved,
}: {
  outcome: Outcome;
  revision: number;
  resolve: (body: DeliveryDecisionBody) => Promise<unknown>;
  errorText: (error: unknown) => string;
  isUncertain: (error: unknown) => boolean;
  close: () => void;
  onResolved: () => void;
}) {
  const noteId = useId();
  const hintId = useId();
  const [id] = useState(() => crypto.randomUUID());
  const [note, setNote] = useState('');
  const mutation = useMutation({
    mutationFn: resolve,
    onSuccess: onResolved,
  });
  const uncertain = mutation.isError && isUncertain(mutation.error);
  const locked = mutation.isPending || uncertain;
  const delivered = outcome === 'delivered';

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !locked) close();
      }}
    >
      <DialogContent showCloseButton={!locked}>
        <DialogTitle>
          {delivered
            ? m.messaging_delivery_delivered_title()
            : m.messaging_delivery_not_delivered_title()}
        </DialogTitle>
        <DialogDescription>
          {delivered
            ? m.messaging_delivery_delivered_description()
            : m.messaging_delivery_not_delivered_description()}
        </DialogDescription>
        <form
          className="delivery-decision-form"
          onSubmit={(event) => {
            event.preventDefault();
            // After an unknown outcome the exact request is repeated, so it applies once.
            mutation.mutate(
              uncertain && mutation.variables
                ? mutation.variables
                : {
                    id,
                    expectedRevision: revision,
                    outcome,
                    note: note.trim() || null,
                  },
            );
          }}
        >
          <label htmlFor={noteId}>{m.messaging_delivery_note()}</label>
          <Textarea
            id={noteId}
            aria-describedby={hintId}
            maxLength={2000}
            disabled={locked}
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
          <p id={hintId} className="delivery-decision-hint">
            {m.messaging_delivery_note_hint()}
          </p>
          {mutation.isError ? (
            <Alert tone={uncertain ? 'warning' : 'danger'} role="alert">
              {errorText(mutation.error)}
            </Alert>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={locked}
              onClick={close}
            >
              {m.common_cancel()}
            </Button>
            <Button
              type="submit"
              variant={delivered ? 'default' : 'destructive'}
              disabled={mutation.isPending}
            >
              {mutation.isPending
                ? m.common_saving()
                : uncertain
                  ? m.common_retry()
                  : delivered
                    ? m.messaging_delivery_confirm_delivered()
                    : m.messaging_delivery_confirm_not_delivered()}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
