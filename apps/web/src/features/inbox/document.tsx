import './inbox.css';

import type {
  DocumentDetail,
  Fact,
  FactLocator,
  FactValue,
} from '@luma/api-contract';
import { formatNumber } from '@luma/i18n/format';
import { m } from '@luma/i18n/messages';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Badge } from '@luma/ui/components/primitives/badge';
import { Button } from '@luma/ui/components/primitives/button';
import { Empty } from '@luma/ui/components/primitives/empty';
import { RefreshButton } from '@luma/ui/components/primitives/refresh-button';
import {
  type CellRange,
  selectedSpan,
  SourceSheet,
  SourceText,
} from '@luma/ui/components/primitives/source-view';
import { StatePill } from '@luma/ui/components/primitives/state';
import { WorkspaceDate } from '@luma/ui/components/primitives/workspace-date';
import { RecordHeader } from '@luma/ui/components/workspace/record-header';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { FileSearch, Mail, Plus } from 'lucide-react';
import { useState } from 'react';

import { SignInRedirect } from '../identity/common';
import { usePermissions } from '../identity/permissions';
import { CommandFeedback } from './command-feedback';
import {
  addFact,
  documentOptions,
  readDocument,
  readFailure,
  reviewFact,
  useInboxCommand,
} from './data';
import {
  emptyFact,
  FactValueFields,
  RecordChoice,
  validFact,
} from './fact-form';
import { useInboxUpdates } from './live';
import { useMembers } from './people';
import {
  cellRange,
  changeLabels,
  confidenceLabels,
  confirmBlock,
  documentStateLabels,
  documentStates,
  documentStateText,
  factKindLabels,
  factRole,
  factStatusLabels,
  factStatusStates,
  factText,
  fileSize,
  groupFacts,
  matchLabels,
  originLabels,
} from './presentation';
import { RecordLink } from './records';

/** A new fact's source: text selected on a page, or picked spreadsheet cells. */
export type SourcePick =
  | {
      kind: 'text';
      page: number | null;
      start: number;
      end: number;
      text: string;
    }
  | ({ kind: 'cells'; sheet: string; text: string } & CellRange);

/** Converts a picked part of the source into the locator the API stores. */
export function pickLocator(pick: SourcePick): FactLocator {
  return pick.kind === 'text'
    ? { kind: 'text', page: pick.page, start: pick.start, end: pick.end }
    : {
        kind: 'cells',
        sheet: pick.sheet,
        row: pick.row,
        rowEnd: pick.rowEnd,
        column: pick.column,
        columnEnd: pick.columnEnd,
      };
}

/** The text of picked cells, joined by row and column, to prefill a fact. */
export function cellText(
  rows: readonly (readonly string[])[],
  range: CellRange,
) {
  return rows
    .slice(range.row - 1, range.rowEnd)
    .map((row) => row.slice(range.column - 1, range.columnEnd).join(' '))
    .join('\n');
}

/**
 * Whether a text fact belongs to a page: its 1-based page, or the only page when the locator has
 * no page (message text and plain files).
 */
export const onPage = (locator: FactLocator, page: number, pages: number) =>
  locator.kind === 'text' &&
  (locator.page === page || (locator.page === null && pages === 1));

/** Loads a document for review and keeps it current while it is being read. */
export function DocumentReviewPage() {
  const { organizationId, documentId } = useParams({
    from: '/app/$organizationId/inbox/documents/$documentId',
  });
  useInboxUpdates(organizationId);
  const query = useQuery(documentOptions(organizationId, documentId));
  const { can } = usePermissions(organizationId);
  const people = useMembers(organizationId);
  const failure = readFailure(query.error);
  if (failure === 'signin') return <SignInRedirect />;

  return (
    <DocumentReviewView
      key={documentId}
      organizationId={organizationId}
      detail={failure === 'access' ? undefined : query.data}
      manage={can('messages.manage')}
      loading={query.isPending}
      refreshing={query.isFetching}
      failure={failure}
      refresh={() => void query.refetch()}
      name={people.name}
    />
  );
}

/**
 * Shows a document's source beside the facts proposed from it. Selecting a fact highlights the
 * text or cells it cites; people confirm, correct or reject facts, and add facts by selecting
 * source text or cells.
 */
export function DocumentReviewView({
  organizationId,
  detail,
  manage,
  loading = false,
  refreshing = false,
  failure,
  refresh,
  name,
}: {
  organizationId: string;
  detail: DocumentDetail | undefined;
  manage: boolean;
  loading?: boolean;
  refreshing?: boolean;
  failure?: ReturnType<typeof readFailure>;
  refresh: () => void;
  name: (id: string) => string;
}) {
  const [selected, setSelected] = useState<string>();
  const [pick, setPick] = useState<SourcePick | null>(null);
  const [adding, setAdding] = useState(false);
  const doc = detail?.document;
  const review = manage && !!detail?.canReview;
  const reread = useInboxCommand(organizationId, (_: null, id) =>
    readDocument({ organizationId }, doc?.id ?? '', id),
  );

  return (
    <div className="messaging-page messaging-document">
      <RecordHeader
        section={{
          label: m.messaging_page_title(),
          icon: Mail,
          link: (
            <Link
              to="/app/$organizationId/inbox"
              params={{ organizationId }}
              search={doc ? { thread: doc.threadId } : {}}
            />
          ),
        }}
        title={doc?.filename ?? m.messaging_document_title_fallback()}
        actions={
          <RefreshButton
            refreshing={refreshing}
            onClick={refresh}
            label={m.messaging_refresh()}
          />
        }
        status={
          doc ? (
            <>
              <StatePill state={documentStates[doc.state]}>
                {documentStateLabels[doc.state]()}
              </StatePill>
              {doc.factsToReview > 0 ? (
                <Badge tone="warning">
                  {m.messaging_row_facts({ count: doc.factsToReview })}
                </Badge>
              ) : null}
              {doc.version > 1 ? (
                <Badge>
                  {m.messaging_document_version({ version: doc.version })}
                </Badge>
              ) : null}
            </>
          ) : null
        }
        description={
          doc ? (
            <>
              {m.messaging_document_received({ size: fileSize(doc.size) })}{' '}
              <WorkspaceDate value={doc.receivedAt} />
              {' · '}
              <Link
                to="/app/$organizationId/inbox"
                params={{ organizationId }}
                search={{ thread: doc.threadId }}
              >
                {m.messaging_document_open_thread()}
              </Link>
              {doc.previousId ? (
                <>
                  {' · '}
                  <Link
                    to="/app/$organizationId/inbox/documents/$documentId"
                    params={{ organizationId, documentId: doc.previousId }}
                  >
                    {m.messaging_document_previous()}
                  </Link>
                </>
              ) : null}
            </>
          ) : null
        }
      />
      {failure && !detail ? (
        <Empty>
          <FileSearch aria-hidden="true" />
          <h2>
            {failure === 'missing'
              ? m.messaging_document_missing_title()
              : failure === 'access'
                ? m.messaging_thread_access_title()
                : m.messaging_thread_unavailable_title()}
          </h2>
          <p>
            {failure === 'missing'
              ? m.messaging_document_missing_text()
              : failure === 'access'
                ? m.messaging_error_access()
                : m.messaging_error_unavailable()}
          </p>
          {failure === 'unavailable' ? (
            <Button variant="outline" onClick={refresh}>
              {m.common_retry()}
            </Button>
          ) : null}
        </Empty>
      ) : failure ? (
        <Alert tone="warning" role="alert">
          {m.messaging_document_stale()}
        </Alert>
      ) : null}
      {loading && !failure ? (
        <div className="messaging-loading" role="status">
          <span className="sr-only">{m.messaging_loading_document()}</span>
          <span className="lu-skeleton" />
          <span className="lu-skeleton" />
        </div>
      ) : null}
      {detail && doc ? (
        <>
          {doc.state !== 'ready' ? (
            <Alert
              tone={
                doc.state === 'failed' || doc.state === 'unreadable'
                  ? 'danger'
                  : doc.state === 'pending' || doc.state === 'reading'
                    ? 'info'
                    : 'neutral'
              }
              role={
                doc.state === 'pending' || doc.state === 'reading'
                  ? 'status'
                  : undefined
              }
            >
              {documentStateText[doc.state]()}
              {doc.stateReason ? ` ${doc.stateReason}` : ''}
              {doc.state === 'duplicate' && doc.duplicateOf ? (
                <>
                  {' '}
                  <Link
                    to="/app/$organizationId/inbox/documents/$documentId"
                    params={{ organizationId, documentId: doc.duplicateOf }}
                  >
                    {m.messaging_document_open_original()}
                  </Link>
                </>
              ) : null}
              {doc.state === 'failed' && manage ? (
                <>
                  {' '}
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={reread.locked}
                    onClick={() => reread.submit(null)}
                  >
                    {reread.isPending
                      ? m.messaging_document_reading()
                      : m.messaging_document_read_again()}
                  </Button>
                </>
              ) : null}
            </Alert>
          ) : null}
          <CommandFeedback command={reread} />
          {!detail.extraction.available && doc.state === 'ready' ? (
            <Alert>
              {detail.extraction.reason
                ? m.messaging_extraction_unavailable_reason({
                    reason: detail.extraction.reason,
                  })
                : m.messaging_extraction_unavailable()}{' '}
              {review ? m.messaging_extraction_manual() : ''}
            </Alert>
          ) : null}
          <div className="messaging-review">
            <section
              className="messaging-review-source"
              aria-label={m.messaging_document_source()}
            >
              <Source
                detail={detail}
                selected={selected}
                onSelect={setSelected}
                onPick={review ? setPick : undefined}
                picked={pick}
              />
              {review && pick && !adding ? (
                <div className="messaging-pick">
                  <span>
                    {pick.kind === 'text'
                      ? m.messaging_pick_text({
                          count: pick.end - pick.start,
                        })
                      : m.messaging_pick_cells({ range: cellRange(pick) })}
                  </span>
                  <Button size="sm" onClick={() => setAdding(true)}>
                    <Plus aria-hidden="true" />
                    {m.messaging_fact_add()}
                  </Button>
                </div>
              ) : null}
            </section>
            <section
              className="messaging-review-facts"
              aria-labelledby="document-facts"
            >
              <h2 id="document-facts">
                {m.messaging_facts_title({ count: detail.facts.length })}
              </h2>
              {review && !pick && detail.representation ? (
                <p className="messaging-muted">{m.messaging_fact_add_hint()}</p>
              ) : null}
              {adding && pick ? (
                <AddFactForm
                  organizationId={organizationId}
                  documentId={doc.id}
                  pick={pick}
                  close={() => {
                    setAdding(false);
                    setPick(null);
                  }}
                />
              ) : null}
              {detail.facts.length ? (
                groupFacts(detail.facts).map((group) => (
                  <div key={group.kind} className="messaging-fact-group">
                    <h3 className="messaging-subheading">
                      {factKindLabels[group.kind]()}
                    </h3>
                    <ul className="messaging-facts-list">
                      {group.facts.map((fact) => (
                        <FactItem
                          key={`${fact.id}:${fact.status}`}
                          organizationId={organizationId}
                          fact={fact}
                          selected={selected === fact.id}
                          onSelect={() => setSelected(fact.id)}
                          review={review}
                          name={name}
                        />
                      ))}
                    </ul>
                  </div>
                ))
              ) : (
                <p className="messaging-muted">
                  {doc.state === 'ready'
                    ? m.messaging_facts_empty()
                    : m.messaging_facts_none_yet()}
                </p>
              )}
              {detail.removedFacts.length ? (
                <div className="messaging-fact-group">
                  <h3 className="messaging-subheading">
                    {m.messaging_facts_removed_title()}
                  </h3>
                  <p className="messaging-muted">
                    {m.messaging_facts_removed_text()}
                  </p>
                  <ul className="messaging-facts-list">
                    {detail.removedFacts.map((fact) => (
                      <li
                        key={fact.id}
                        className="messaging-fact"
                        data-removed=""
                      >
                        <span className="messaging-fact-role">
                          {factRole(fact.value)}
                        </span>
                        <strong>{factText(fact.value)}</strong>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </section>
          </div>
        </>
      ) : null}
    </div>
  );
}

function Source({
  detail,
  selected,
  onSelect,
  onPick,
  picked,
}: {
  detail: DocumentDetail;
  selected: string | undefined;
  onSelect: (id: string) => void;
  onPick: ((pick: SourcePick | null) => void) | undefined;
  picked: SourcePick | null;
}) {
  const [sheetIndex, setSheetIndex] = useState(0);
  const representation = detail.representation;
  const selectedFact = detail.facts.find((fact) => fact.id === selected);
  const activeSheet =
    representation?.kind === 'sheets' && selectedFact?.locator.kind === 'cells'
      ? Math.max(
          0,
          representation.sheets.findIndex(
            (sheet) =>
              selectedFact.locator.kind === 'cells' &&
              sheet.name === selectedFact.locator.sheet,
          ),
        )
      : sheetIndex;

  if (!representation)
    return (
      <p className="messaging-muted">{m.messaging_document_no_content()}</p>
    );

  if (representation.kind === 'text') {
    const pages = representation.pages;

    return (
      <div className="messaging-pages">
        {pages.map((text, index) => {
          const page = index + 1;
          const readSelection = (container: HTMLElement) => {
            if (!onPick) return;
            const span = selectedSpan(
              container.querySelector('[data-source-text]') ?? container,
            );
            if (span)
              onPick({
                kind: 'text',
                page: pages.length > 1 ? page : null,
                ...span,
              });
          };
          const label =
            pages.length > 1
              ? m.messaging_document_page({ page: formatNumber(page) })
              : m.messaging_document_text();

          return (
            <div
              key={page}
              className="messaging-page-source"
              // Mouse and keyboard (Shift with arrow keys under caret browsing) selections both
              // become the source of a new fact.
              onMouseUp={(event) => readSelection(event.currentTarget)}
              onKeyUp={(event) => readSelection(event.currentTarget)}
            >
              {pages.length > 1 ? (
                <h3 className="messaging-subheading">{label}</h3>
              ) : null}
              <SourceText
                label={label}
                text={text}
                selected={selected}
                onSelect={onSelect}
                spans={[
                  ...detail.facts.flatMap((fact) =>
                    fact.locator.kind === 'text' &&
                    onPage(fact.locator, page, pages.length)
                      ? [
                          {
                            id: fact.id,
                            start: fact.locator.start,
                            end: fact.locator.end,
                          },
                        ]
                      : [],
                  ),
                  ...(picked?.kind === 'text' && (picked.page ?? 1) === page
                    ? [{ id: 'pick', start: picked.start, end: picked.end }]
                    : []),
                ]}
              />
            </div>
          );
        })}
      </div>
    );
  }

  const sheet = representation.sheets[activeSheet];

  return (
    <div className="messaging-sheets">
      {representation.sheets.length > 1 ? (
        <div
          className="messaging-inline-actions"
          role="group"
          aria-label={m.messaging_document_sheets()}
        >
          {representation.sheets.map((option, index) => (
            <Button
              key={option.name}
              size="sm"
              variant={index === activeSheet ? 'outline' : 'ghost'}
              aria-pressed={index === activeSheet}
              onClick={() => setSheetIndex(index)}
            >
              {option.name}
            </Button>
          ))}
        </div>
      ) : null}
      {sheet ? (
        <SourceSheet
          name={m.messaging_document_sheet({ name: sheet.name })}
          rows={sheet.rows}
          selected={selected}
          onSelect={onSelect}
          ranges={detail.facts.flatMap((fact) =>
            fact.locator.kind === 'cells' && fact.locator.sheet === sheet.name
              ? [{ id: fact.id, ...fact.locator }]
              : [],
          )}
          picked={
            picked?.kind === 'cells' && picked.sheet === sheet.name
              ? picked
              : null
          }
          onPick={
            onPick
              ? (range) =>
                  onPick({
                    kind: 'cells',
                    sheet: sheet.name,
                    text: cellText(sheet.rows, range),
                    ...range,
                  })
              : undefined
          }
        />
      ) : null}
    </div>
  );
}

function Match({
  organizationId,
  fact,
}: {
  organizationId: string;
  fact: Fact;
}) {
  const { match } = fact;
  if (match.state === 'not_applicable') return null;

  return (
    <div className="messaging-fact-match" data-state={match.state}>
      <span>{matchLabels[match.state]()}</span>
      {match.record ? (
        <RecordLink organizationId={organizationId} record={match.record} />
      ) : null}
      {match.state === 'ambiguous' && match.candidates.length ? (
        <ul aria-label={m.messaging_fact_candidates()}>
          {match.candidates.map((record) => (
            <li key={`${record.kind}:${record.id}`}>
              <RecordLink organizationId={organizationId} record={record} />
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function FactItem({
  organizationId,
  fact,
  selected,
  onSelect,
  review,
  name,
}: {
  organizationId: string;
  fact: Fact;
  selected: boolean;
  onSelect: () => void;
  review: boolean;
  name: (id: string) => string;
}) {
  const [correcting, setCorrecting] = useState(false);
  const command = useInboxCommand(
    organizationId,
    (body: Omit<Parameters<typeof reviewFact>[2], 'id'>, id) =>
      reviewFact({ organizationId }, fact.id, { ...body, id }),
    () => setCorrecting(false),
  );
  const open = fact.status === 'proposed' || fact.status === 'needs_correction';
  const blocked = confirmBlock(fact);
  const locator =
    fact.locator.kind === 'text'
      ? fact.locator.page
        ? m.messaging_fact_on_page({ page: formatNumber(fact.locator.page) })
        : null
      : m.messaging_fact_in_cells({
          sheet: fact.locator.sheet,
          range: cellRange(fact.locator),
        });

  return (
    <li
      className="messaging-fact"
      data-selected={selected || undefined}
      data-status={fact.status}
    >
      <div className="messaging-fact-head">
        <button
          type="button"
          className="messaging-fact-select"
          aria-pressed={selected}
          onClick={onSelect}
        >
          <span className="messaging-fact-role">{factRole(fact.value)}</span>
          <strong>{factText(fact.value)}</strong>
          <span className="sr-only">{m.messaging_fact_show()}</span>
        </button>
        <StatePill state={factStatusStates[fact.status]}>
          {factStatusLabels[fact.status]()}
        </StatePill>
      </div>
      <blockquote className="messaging-quote">{fact.quote}</blockquote>
      <div className="messaging-fact-meta">
        {fact.confidence === 'low' ? (
          <Badge tone="warning">{confidenceLabels.low()}</Badge>
        ) : (
          <Badge>{confidenceLabels.high()}</Badge>
        )}
        <Badge>{originLabels[fact.origin]()}</Badge>
        {fact.change ? (
          <Badge tone={fact.change === 'unchanged' ? 'neutral' : 'info'}>
            {changeLabels[fact.change]()}
          </Badge>
        ) : null}
        {locator ? <span className="messaging-muted">{locator}</span> : null}
      </div>
      <Match organizationId={organizationId} fact={fact} />
      {fact.review ? (
        <p className="messaging-muted">
          {m.messaging_fact_reviewed({
            outcome:
              fact.review.outcome === 'confirmed'
                ? m.messaging_fact_status_confirmed()
                : fact.review.outcome === 'corrected'
                  ? m.messaging_fact_corrected()
                  : m.messaging_fact_status_rejected(),
            name: name(fact.review.by),
          })}{' '}
          <WorkspaceDate value={fact.review.at} />
          {fact.review.original
            ? ` · ${m.messaging_fact_original({ value: factText(fact.review.original) })}`
            : ''}
        </p>
      ) : null}
      {review && open && !correcting ? (
        <div className="messaging-inline-actions">
          <Button
            size="sm"
            disabled={command.locked || !!blocked}
            aria-describedby={blocked ? `fact-${fact.id}-blocked` : undefined}
            onClick={() => command.submit({ outcome: 'confirm' })}
          >
            {m.messaging_fact_confirm()}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={command.locked}
            onClick={() => setCorrecting(true)}
          >
            {m.messaging_fact_correct()}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={command.locked}
            onClick={() => command.submit({ outcome: 'reject' })}
          >
            {m.messaging_fact_reject()}
          </Button>
          {blocked ? (
            <span id={`fact-${fact.id}-blocked`} className="messaging-muted">
              {blocked}
            </span>
          ) : null}
        </div>
      ) : null}
      {correcting ? (
        <CorrectForm
          fact={fact}
          locked={command.locked}
          submit={(correction) =>
            command.submit({ outcome: 'correct', correction })
          }
          cancel={() => setCorrecting(false)}
        />
      ) : null}
      <CommandFeedback command={command} />
    </li>
  );
}

function CorrectForm({
  fact,
  locked,
  submit,
  cancel,
}: {
  fact: Fact;
  locked: boolean;
  submit: (correction: {
    value: FactValue;
    record: {
      kind: Fact['match']['candidates'][number]['kind'];
      id: string;
    } | null;
  }) => void;
  cancel: () => void;
}) {
  const [value, setValue] = useState<FactValue>(fact.value);
  const options = [
    ...(fact.match.record ? [fact.match.record] : []),
    ...fact.match.candidates.filter(
      (candidate) =>
        candidate.kind !== fact.match.record?.kind ||
        candidate.id !== fact.match.record.id,
    ),
  ];
  const [record, setRecord] = useState(
    fact.match.record
      ? `${fact.match.record.kind}:${fact.match.record.id}`
      : '',
  );
  const [invalid, setInvalid] = useState(false);

  return (
    <form
      className="messaging-form"
      aria-label={m.messaging_fact_correct()}
      onSubmit={(event) => {
        event.preventDefault();
        const valid = validFact(value);
        if (!valid) {
          setInvalid(true);

          return;
        }
        setInvalid(false);
        const chosen = options.find(
          (option) => `${option.kind}:${option.id}` === record,
        );
        submit({
          value: valid,
          record: chosen ? { kind: chosen.kind, id: chosen.id } : null,
        });
      }}
    >
      <fieldset disabled={locked}>
        <FactValueFields
          value={value}
          onChange={setValue}
          kindEditable={false}
        />
        <RecordChoice options={options} value={record} onChange={setRecord} />
      </fieldset>
      {invalid ? (
        <p className="messaging-error" role="alert">
          {m.messaging_fact_invalid()}
        </p>
      ) : null}
      <div className="messaging-inline-actions">
        <Button size="sm" type="submit" disabled={locked}>
          {m.messaging_fact_save_correction()}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          type="button"
          disabled={locked}
          onClick={cancel}
        >
          {m.common_cancel()}
        </Button>
      </div>
    </form>
  );
}

function AddFactForm({
  organizationId,
  documentId,
  pick,
  close,
}: {
  organizationId: string;
  documentId: string;
  pick: SourcePick;
  close: () => void;
}) {
  const [value, setValue] = useState<FactValue>(() =>
    emptyFact('reference', pick.text),
  );
  const [invalid, setInvalid] = useState(false);
  const command = useInboxCommand(
    organizationId,
    (body: { value: FactValue; locator: FactLocator }, id) =>
      addFact({ organizationId }, documentId, { id, ...body }),
    close,
  );

  return (
    <form
      className="messaging-form messaging-add-fact"
      aria-label={m.messaging_fact_add()}
      onSubmit={(event) => {
        event.preventDefault();
        const valid = validFact(value);
        if (!valid) {
          setInvalid(true);

          return;
        }
        setInvalid(false);
        command.submit({ value: valid, locator: pickLocator(pick) });
      }}
    >
      <h3 className="messaging-subheading">{m.messaging_fact_add()}</h3>
      <blockquote className="messaging-quote">{pick.text}</blockquote>
      <fieldset disabled={command.locked}>
        <FactValueFields
          value={value}
          onChange={(next) =>
            setValue(
              next.kind === value.kind ? next : emptyFact(next.kind, pick.text),
            )
          }
        />
      </fieldset>
      {invalid ? (
        <p className="messaging-error" role="alert">
          {m.messaging_fact_invalid()}
        </p>
      ) : null}
      <CommandFeedback command={command} />
      <div className="messaging-inline-actions">
        <Button size="sm" type="submit" disabled={command.isPending}>
          {command.isPending
            ? m.common_saving()
            : command.uncertain
              ? m.messaging_retry_same()
              : m.messaging_fact_add_submit()}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          type="button"
          disabled={command.locked}
          onClick={close}
        >
          {m.common_cancel()}
        </Button>
      </div>
    </form>
  );
}
