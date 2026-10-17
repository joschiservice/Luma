import type { Outbound, ThreadDetail } from '@luma/api-contract';
import { formatList } from '@luma/i18n/format';
import { m } from '@luma/i18n/messages';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Button } from '@luma/ui/components/primitives/button';
import { Disclosure } from '@luma/ui/components/primitives/disclosure';
import { Input } from '@luma/ui/components/primitives/input';
import { StatePill } from '@luma/ui/components/primitives/state';
import { Textarea } from '@luma/ui/components/primitives/textarea';
import { WorkspaceDate } from '@luma/ui/components/primitives/workspace-date';
import { useQueryClient } from '@tanstack/react-query';
import { PenLine, Send } from 'lucide-react';
import { useId, useState } from 'react';
import { z } from 'zod';

import { DeliveryDecision } from '../../shared/messaging/delivery-decision';
import { CommandFeedback } from './command-feedback';
import {
  checkOutbound,
  commandError,
  decideOutbound,
  discardOutbound,
  downloadSupplierPdf,
  draftReply,
  messagingKey,
  requestOutbound,
  resolveOutboundDelivery,
  sendOutbound,
  uncertainOutcome,
  updateOutbound,
  useInboxCommand,
} from './data';
import {
  addressLabel,
  consequentialLabels,
  freshnessLabels,
  freshnessStates,
  outboundStateLabels,
  outboundStates,
  outboundStateText,
  settledReply,
} from './presentation';
import { RecordLink } from './records';

type People = { name: (id: string) => string; self: string | undefined };

const email = z.string().trim().toLowerCase().email().max(320);

/**
 * Splits a comma- or semicolon-separated address list. Returns the normalized addresses, or the
 * first entry that isn't an email address.
 */
export function parseAddresses(
  value: string,
): { ok: true; addresses: string[] } | { ok: false; invalid: string } {
  const entries = value
    .split(/[,;\n]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  const addresses: string[] = [];
  for (const entry of entries) {
    const parsed = email.safeParse(entry);
    if (!parsed.success) return { ok: false, invalid: entry };
    addresses.push(parsed.data);
  }

  return { ok: true, addresses };
}

/**
 * Drafts, reviews and sends replies. Drafts come from the linked records' current state and cite
 * them; consequential replies need someone else's approval; a sent reply counts only after a
 * fresh read of the thread finds it.
 */
export function Replies({
  organizationId,
  detail,
  send,
  approve,
  people,
}: {
  organizationId: string;
  detail: ThreadDetail;
  send: boolean;
  approve: boolean;
  people: People;
}) {
  const replies = [...detail.outbound].sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  );
  const current = replies.filter((reply) => !settledReply(reply));
  const earlier = replies.filter(settledReply);
  const draft = useInboxCommand(organizationId, (_: null, id) =>
    draftReply({ organizationId }, detail.thread.id, id),
  );

  return (
    <section className="messaging-section" aria-labelledby="thread-reply">
      <div className="messaging-section-heading">
        <h3 id="thread-reply">{m.messaging_reply_title()}</h3>
        {send && !current.length ? (
          <Button
            size="sm"
            variant="outline"
            disabled={draft.locked}
            onClick={() => draft.submit(null)}
          >
            <PenLine aria-hidden="true" />
            {draft.isPending
              ? m.messaging_reply_drafting()
              : m.messaging_reply_draft()}
          </Button>
        ) : null}
      </div>
      {!current.length ? (
        <p className="messaging-muted">
          {send
            ? m.messaging_reply_draft_hint()
            : m.messaging_reply_no_permission()}
        </p>
      ) : null}
      <CommandFeedback command={draft} />
      {current.map((reply) => (
        <ReplyCard
          key={`${reply.id}:${reply.revision}`}
          organizationId={organizationId}
          reply={reply}
          send={send}
          approve={approve}
          people={people}
        />
      ))}
      {earlier.length ? (
        <Disclosure>
          <summary>
            {m.messaging_reply_earlier({ count: earlier.length })}
          </summary>
          {earlier.map((reply) => (
            <ReplyCard
              key={`${reply.id}:${reply.revision}`}
              organizationId={organizationId}
              reply={reply}
              send={false}
              approve={false}
              people={people}
            />
          ))}
        </Disclosure>
      ) : null}
    </section>
  );
}

/** One reply: its state, content, citations, why it needs approval, and the next control. */
function ReplyCard({
  organizationId,
  reply,
  send,
  approve,
  people,
}: {
  organizationId: string;
  reply: Outbound;
  send: boolean;
  approve: boolean;
  people: People;
}) {
  const org = { organizationId };
  const client = useQueryClient();
  const editing = reply.state === 'draft' && reply.canEdit && send;
  const [to, setTo] = useState(() => reply.to.map((a) => a.address).join(', '));
  const [cc, setCc] = useState(() => reply.cc.map((a) => a.address).join(', '));
  const [subject, setSubject] = useState(reply.subject);
  const [text, setText] = useState(reply.text);
  const [downloadError, setDownloadError] = useState(false);
  const [invalid, setInvalid] = useState<string>();
  const dirty =
    to !== reply.to.map((a) => a.address).join(', ') ||
    cc !== reply.cc.map((a) => a.address).join(', ') ||
    subject !== reply.subject ||
    text !== reply.text;
  const fields = useId();

  const save = useInboxCommand(
    organizationId,
    (body: Parameters<typeof updateOutbound>[2]) =>
      updateOutbound(org, reply.id, body),
  );
  const request = useInboxCommand(organizationId, (_: null, id) =>
    requestOutbound(org, reply.id, id),
  );
  const discard = useInboxCommand(organizationId, (_: null, id) =>
    discardOutbound(org, reply.id, id),
  );
  const decide = useInboxCommand(
    organizationId,
    (outcome: 'approved' | 'rejected') =>
      decideOutbound(org, reply.id, {
        decisionId: reply.decisionId ?? '',
        outcome,
      }),
  );
  const dispatch = useInboxCommand(organizationId, (_: null, id) =>
    sendOutbound(org, reply.id, id),
  );
  const check = useInboxCommand(organizationId, (_: null, id) =>
    checkOutbound(org, reply.id, id),
  );
  const commands = [save, request, discard, decide, dispatch, check];
  const locked = commands.some((command) => command.locked);
  const consequential = reply.consequential.length > 0;
  const own = people.self !== undefined && reply.requestedBy === people.self;

  return (
    <article
      className="messaging-reply"
      data-state={reply.state}
      aria-label={m.messaging_reply_label({
        state: outboundStateLabels[reply.state](),
      })}
    >
      <header className="messaging-reply-header">
        <StatePill state={outboundStates[reply.state]}>
          {outboundStateLabels[reply.state]()}
        </StatePill>
        <span className="messaging-muted">
          {m.messaging_reply_by({ name: people.name(reply.requestedBy) })} ·{' '}
          <WorkspaceDate value={reply.updatedAt} />
        </span>
      </header>
      <p className="messaging-reply-state">
        {outboundStateText[reply.state]()}
        {reply.stateReason ? ` ${reply.stateReason}` : ''}
      </p>
      {reply.purchaseOrderId ? (
        <DeliveryDecision
          outbound={reply}
          name={people.name}
          resolve={(body) => resolveOutboundDelivery(org, reply.id, body)}
          errorText={commandError}
          isUncertain={uncertainOutcome}
          onResolved={() =>
            void client.invalidateQueries({
              queryKey: messagingKey(organizationId),
            })
          }
        />
      ) : null}
      {consequential ? (
        <Alert tone="warning" className="messaging-reply-reasons">
          {m.messaging_reply_needs_approval({
            reasons: formatList(
              reply.consequential.map((reason) =>
                consequentialLabels[reason](),
              ),
            ),
          })}
        </Alert>
      ) : null}
      {editing ? (
        <form
          className="messaging-form"
          onSubmit={(event) => {
            event.preventDefault();
            const toList = parseAddresses(to);
            const ccList = parseAddresses(cc);
            if (!toList.ok || !ccList.ok) {
              setInvalid(
                !toList.ok ? toList.invalid : !ccList.ok ? ccList.invalid : '',
              );

              return;
            }
            setInvalid(undefined);
            save.submit({
              expectedRevision: reply.revision,
              to: toList.addresses,
              cc: ccList.addresses,
              subject: subject.trim(),
              text: text.trim(),
            });
          }}
        >
          <fieldset disabled={locked} className="messaging-reply-fields">
            <label className="messaging-field" htmlFor={`${fields}-to`}>
              {m.messaging_to()}
              <Input
                id={`${fields}-to`}
                required
                value={to}
                onChange={(event) => setTo(event.target.value)}
              />
            </label>
            <label className="messaging-field" htmlFor={`${fields}-cc`}>
              {m.messaging_cc()}
              <Input
                id={`${fields}-cc`}
                value={cc}
                onChange={(event) => setCc(event.target.value)}
              />
            </label>
            <label className="messaging-field" htmlFor={`${fields}-subject`}>
              {m.messaging_reply_subject()}
              <Input
                id={`${fields}-subject`}
                required
                maxLength={500}
                value={subject}
                onChange={(event) => setSubject(event.target.value)}
              />
            </label>
            <label className="messaging-field" htmlFor={`${fields}-text`}>
              {m.messaging_reply_text()}
              <Textarea
                id={`${fields}-text`}
                required
                rows={10}
                maxLength={20000}
                value={text}
                onChange={(event) => setText(event.target.value)}
              />
            </label>
          </fieldset>
          {invalid !== undefined ? (
            <p className="messaging-error" role="alert">
              {m.messaging_reply_address_invalid({ address: invalid })}
            </p>
          ) : null}
          <CommandFeedback command={save} />
          {dirty ? (
            <div className="messaging-inline-actions">
              <Button type="submit" size="sm" disabled={locked}>
                {save.isPending ? m.common_saving() : m.messaging_reply_save()}
              </Button>
              <span className="messaging-muted">
                {m.messaging_reply_save_first()}
              </span>
            </div>
          ) : null}
        </form>
      ) : (
        <div className="messaging-reply-content">
          <dl className="messaging-message-meta">
            <div>
              <dt>{m.messaging_to()}</dt>
              <dd>{formatList(reply.to.map(addressLabel))}</dd>
            </div>
            {reply.cc.length ? (
              <div>
                <dt>{m.messaging_cc()}</dt>
                <dd>{formatList(reply.cc.map(addressLabel))}</dd>
              </div>
            ) : null}
            <div>
              <dt>{m.messaging_reply_subject()}</dt>
              <dd>{reply.subject}</dd>
            </div>
          </dl>
          <div className="messaging-message-text">{reply.text}</div>
        </div>
      )}
      {reply.attachments?.length ? (
        <div className="messaging-inline-actions">
          <p>
            {reply.attachments
              .map((attachment) => attachment.filename)
              .join(', ')}
          </p>
          {reply.purchaseOrderId ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setDownloadError(false);
                void downloadSupplierPdf(
                  organizationId,
                  reply.purchaseOrderId!,
                  reply.id,
                ).catch(() => setDownloadError(true));
              }}
            >
              {m.procurement_email_pdf()}
            </Button>
          ) : null}
        </div>
      ) : null}
      {downloadError ? (
        <Alert tone="danger" role="alert">
          {m.procurement_email_unavailable()}
        </Alert>
      ) : null}
      {reply.citations.length ? (
        <div className="messaging-citations">
          <h4 className="messaging-subheading">
            {m.messaging_citations_title()}
          </h4>
          <ul>
            {reply.citations.map((citation, index) => (
              <li
                key={`${citation.record.kind}:${citation.record.id}:${index}`}
              >
                <div className="messaging-link-main">
                  <RecordLink
                    organizationId={organizationId}
                    record={citation.record}
                  />
                  <StatePill state={freshnessStates[citation.freshness]}>
                    {freshnessLabels[citation.freshness]()}
                  </StatePill>
                </div>
                <p>{citation.statement}</p>
                <p className="messaging-muted">
                  {citation.observedAt ? (
                    <>
                      {m.messaging_citation_observed()}{' '}
                      <WorkspaceDate value={citation.observedAt} />
                    </>
                  ) : (
                    m.messaging_citation_not_observed()
                  )}
                </p>
              </li>
            ))}
          </ul>
        </div>
      ) : reply.state === 'draft' ? (
        <p className="messaging-muted">{m.messaging_citations_none()}</p>
      ) : null}
      <div className="messaging-inline-actions">
        {reply.state === 'draft' && send && reply.canRequest ? (
          <Button
            size="sm"
            disabled={locked || dirty}
            title={dirty ? m.messaging_reply_save_first() : undefined}
            onClick={() => request.submit(null)}
          >
            <Send aria-hidden="true" />
            {request.isPending
              ? m.messaging_reply_requesting()
              : consequential
                ? m.messaging_reply_request_approval()
                : m.messaging_reply_send()}
          </Button>
        ) : null}
        {reply.state === 'approval_required' && reply.canApprove && approve ? (
          reply.decisionId && !own ? (
            <>
              <Button
                size="sm"
                disabled={locked}
                onClick={() => decide.submit('approved')}
              >
                {m.messaging_reply_approve()}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={locked}
                onClick={() => decide.submit('rejected')}
              >
                {m.messaging_reply_reject()}
              </Button>
            </>
          ) : null
        ) : reply.state === 'approval_required' ? (
          <span className="messaging-muted">
            {own
              ? m.messaging_reply_waiting_other()
              : m.messaging_reply_waiting_approver()}
          </span>
        ) : null}
        {reply.state === 'approved' && send && reply.canSend ? (
          <Button
            size="sm"
            disabled={locked}
            onClick={() => dispatch.submit(null)}
          >
            <Send aria-hidden="true" />
            {dispatch.isPending
              ? m.messaging_reply_sending()
              : m.messaging_reply_send_approved()}
          </Button>
        ) : null}
        {reply.state === 'uncertain' && send && reply.canCheck ? (
          <Button
            size="sm"
            variant="outline"
            disabled={locked}
            onClick={() => check.submit(null)}
          >
            {check.isPending
              ? m.messaging_reply_checking()
              : m.messaging_reply_check()}
          </Button>
        ) : null}
        {['draft', 'approval_required'].includes(reply.state) && send ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={locked}
            onClick={() => discard.submit(null)}
          >
            {m.messaging_reply_discard()}
          </Button>
        ) : null}
      </div>
      {commands.slice(1).map((command, index) => (
        <CommandFeedback key={index} command={command} />
      ))}
    </article>
  );
}
