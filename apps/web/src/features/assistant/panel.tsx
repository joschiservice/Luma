import './assistant.css';

import type { AssistantAnswer, AssistantContext } from '@luma/api-contract';
import { formatTime } from '@luma/i18n/format';
import { m } from '@luma/i18n/messages';
import { rich } from '@luma/i18n/rich';
import { Alert } from '@luma/ui/components/primitives/alert';
import { LumaMark } from '@luma/ui/components/primitives/brand';
import { Button } from '@luma/ui/components/primitives/button';
import { Kbd } from '@luma/ui/components/primitives/kbd';
import { Spinner } from '@luma/ui/components/primitives/spinner';
import { WorkspaceTimezone } from '@luma/ui/components/primitives/workspace-date';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowUp,
  ArrowUpRight,
  Check,
  Copy,
  RotateCcw,
  Square,
  SquarePen,
  X,
} from 'lucide-react';
import {
  type FormEvent,
  type KeyboardEvent,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';

import {
  setAssistantOpen,
  subscribeAssistantDraft,
} from '../../lib/assistant-panel';
import { usesCommandKey } from '../../lib/keyboard';
import { AnswerContent, AnswerSteps } from './answer';
import {
  askAssistant,
  assistantAvailabilityOptions,
  assistantError,
} from './data';
import {
  citationKey,
  type Exchange,
  historyFor,
  suggestionsFor,
} from './presentation';

const maxQuestion = 2000;
const subscribePlatform = () => () => undefined;
const platformModifier = () =>
  usesCommandKey() ? '⌘' : m.assistant_key_control();

/** Moves focus back to the header toggle after the panel closes. */
function closePanel() {
  setAssistantOpen(false);
  document.querySelector<HTMLElement>('.assistant-toggle')?.focus();
}

/** The overlay layout covers the page, so following a link should reveal the record. */
function closeIfOverlay() {
  if (window.matchMedia('(max-width: 900px)').matches) setAssistantOpen(false);
}

/** Copies an answer as plain text, with numbered sources instead of citation markers. */
function plainText(answer: AssistantAnswer) {
  let text = answer.content;
  answer.citations.forEach((citation, index) => {
    text = text.replaceAll(citationKey(citation), `[${index + 1}]`);
  });
  if (!answer.citations.length) return text;

  return `${text}\n\n${m.common_sources()}\n${answer.citations
    .map((citation, index) => `[${index + 1}] ${citation.label}`)
    .join('\n')}`;
}

function CopyAnswer({ answer }: { answer: AssistantAnswer }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1600);

    return () => window.clearTimeout(timer);
  }, [copied]);

  return (
    <Button
      variant="ghost"
      size="sm"
      className="assistant-answer-action"
      onClick={() => {
        void navigator.clipboard
          .writeText(plainText(answer))
          .then(() => setCopied(true))
          .catch(() => undefined);
      }}
    >
      {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
      {copied ? m.common_copied() : m.common_copy()}
    </Button>
  );
}

function Thinking() {
  const [slow, setSlow] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => setSlow(true), 12_000);

    return () => window.clearTimeout(timer);
  }, []);

  return (
    <div className="assistant-thinking" role="status">
      <span className="assistant-thinking-dots" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      {slow ? m.assistant_thinking_slow() : m.assistant_thinking()}
    </div>
  );
}

function ExchangeView({
  exchange,
  organizationId,
  onRetry,
}: {
  exchange: Exchange;
  organizationId: string;
  onRetry: () => void;
}) {
  const timeZone = useContext(WorkspaceTimezone);
  const { state } = exchange;

  return (
    <article className="assistant-exchange" data-exchange={exchange.id}>
      <p className="assistant-question">{exchange.question}</p>
      <div className="assistant-answer" aria-busy={state.status === 'pending'}>
        <LumaMark className="assistant-answer-mark" tone="mono" />
        <div className="assistant-answer-body">
          {state.status === 'pending' ? <Thinking /> : null}
          {state.status === 'stopped' ? (
            <p className="assistant-muted">{m.assistant_stopped()}</p>
          ) : null}
          {state.status === 'failed' ? (
            <Alert tone="danger" role="alert" className="assistant-failure">
              <p>{state.message}</p>
              <Button variant="outline" size="sm" onClick={onRetry}>
                <RotateCcw aria-hidden="true" />
                {m.common_try_again()}
              </Button>
            </Alert>
          ) : null}
          {state.status === 'answered' ? (
            <>
              <AnswerSteps steps={state.answer.steps} />
              <AnswerContent
                answer={state.answer}
                organizationId={organizationId}
                onNavigate={closeIfOverlay}
              />
              <footer className="assistant-answer-footer">
                <span>
                  {state.answer.outcome === 'incomplete' ? (
                    <span className="assistant-incomplete">
                      {m.assistant_answer_incomplete()} ·{' '}
                    </span>
                  ) : null}
                  {m.assistant_answer_as_of({
                    time: formatTime(state.answer.asOf, {
                      timeZone,
                      hour: '2-digit',
                      minute: '2-digit',
                    }),
                  })}
                </span>
                <CopyAnswer answer={state.answer} />
              </footer>
            </>
          ) : null}
        </div>
      </div>
    </article>
  );
}

/**
 * The Ask Luma panel. People ask questions about their workspace; answers cite the records
 * they came from. Conversations live in memory for this page session and are never saved.
 */
export function AssistantPanel({
  organizationId,
  open,
}: {
  organizationId: string;
  open: boolean;
}) {
  const timeZone = useContext(WorkspaceTimezone);
  const availability = useQuery({
    ...assistantAvailabilityOptions(organizationId),
    enabled: open,
  });
  const [exchanges, setExchanges] = useState<Exchange[]>([]);
  const [draft, setDraft] = useState('');
  const [contextual, setContextual] = useState<{
    context: AssistantContext;
    label: string;
  }>();
  const [announcement, setAnnouncement] = useState('');
  const pending = exchanges.some(
    (exchange) => exchange.state.status === 'pending',
  );
  const abort = useRef<AbortController | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const log = useRef<HTMLDivElement>(null);
  const modifier = useSyncExternalStore(
    subscribePlatform,
    platformModifier,
    m.assistant_key_control,
  );
  const available = availability.data?.available === true;

  useEffect(() => () => abort.current?.abort(), []);

  useEffect(() => {
    if (open) input.current?.focus();
  }, [open]);

  useEffect(
    () =>
      subscribeAssistantDraft((question, nextContext) => {
        abort.current?.abort();
        setExchanges([]);
        setContextual(nextContext);
        setDraft(question.slice(0, maxQuestion));
        requestAnimationFrame(() => input.current?.focus());
      }),
    [],
  );

  function reveal(id: string, block: ScrollLogicalPosition) {
    requestAnimationFrame(() => {
      const reduce = window.matchMedia(
        '(prefers-reduced-motion: reduce)',
      ).matches;
      log.current
        ?.querySelector(`[data-exchange="${id}"]`)
        ?.scrollIntoView({ block, behavior: reduce ? 'auto' : 'smooth' });
    });
  }

  function update(id: string, state: Exchange['state']) {
    setExchanges((current) =>
      current.map((exchange) =>
        exchange.id === id ? { ...exchange, state } : exchange,
      ),
    );
  }

  async function ask(question: string, before: Exchange[] = exchanges) {
    const text = question.trim();
    if (!text || pending || !available) return;
    const id = crypto.randomUUID();
    const controller = new AbortController();
    abort.current = controller;
    setExchanges([
      ...before,
      { id, question: text, state: { status: 'pending' } },
    ]);
    setAnnouncement('');
    reveal(id, 'end');
    try {
      const answer = await askAssistant(
        organizationId,
        {
          question: text,
          history: historyFor(before),
          timeZone,
          context: contextual?.context,
        },
        controller.signal,
      );
      update(id, { status: 'answered', answer });
      setAnnouncement(
        answer.citations.length
          ? m.assistant_announce_answered_sources({
              count: answer.citations.length,
            })
          : m.assistant_announce_answered(),
      );
      reveal(id, 'start');
    } catch (error) {
      if (controller.signal.aborted) update(id, { status: 'stopped' });
      else {
        const message = assistantError(error);
        update(id, { status: 'failed', message });
        setAnnouncement(message);
      }
    } finally {
      if (abort.current === controller) abort.current = null;
    }
  }

  function submit(event?: FormEvent) {
    event?.preventDefault();
    if (!draft.trim() || pending) return;
    void ask(draft);
    setDraft('');
  }

  function onComposerKey(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (
      event.key === 'Enter' &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      submit();
    }
  }

  function reset() {
    abort.current?.abort();
    setExchanges([]);
    setDraft('');
    setContextual(undefined);
    setAnnouncement(m.assistant_announce_new_conversation());
    input.current?.focus();
  }

  const suggestions = suggestionsFor(availability.data?.reads ?? []);

  return (
    <aside
      id="assistant-panel"
      className="assistant-panel"
      aria-label={m.assistant_title()}
      hidden={!open}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !event.defaultPrevented) {
          event.preventDefault();
          closePanel();
        }
      }}
    >
      <header className="assistant-header">
        <LumaMark className="assistant-header-mark" />
        <h2>{m.assistant_title()}</h2>
        <div className="assistant-header-tools">
          <Button
            variant="ghost"
            size="icon"
            aria-label={m.assistant_header_new_conversation()}
            title={m.assistant_header_new_conversation()}
            disabled={!exchanges.length}
            onClick={reset}
          >
            <SquarePen aria-hidden="true" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label={m.assistant_header_close()}
            title={m.assistant_header_close_title({
              shortcut: `${modifier} J`,
            })}
            onClick={closePanel}
          >
            <X aria-hidden="true" />
          </Button>
        </div>
      </header>

      {contextual ? (
        <Alert tone="neutral" role="status" className="assistant-notice">
          <strong>
            {m.assistant_context_record({ label: contextual.label })}
          </strong>
          <p>{m.assistant_context_boundary()}</p>
        </Alert>
      ) : null}
      <div className="assistant-log" ref={log} aria-live="off">
        {availability.isPending && open ? (
          <div className="assistant-state" role="status">
            <Spinner aria-label={m.assistant_availability_checking()} />
          </div>
        ) : availability.isError ? (
          <Alert tone="warning" role="alert" className="assistant-notice">
            <p>{m.assistant_availability_failed()}</p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void availability.refetch()}
            >
              <RotateCcw aria-hidden="true" />
              {m.common_try_again()}
            </Button>
          </Alert>
        ) : availability.data && !available ? (
          <div className="assistant-empty">
            <LumaMark className="assistant-empty-mark" tone="mono" />
            <h3>{m.assistant_unavailable_title()}</h3>
            <Alert tone="neutral" role="status" className="assistant-notice">
              {availability.data.reason}
            </Alert>
          </div>
        ) : exchanges.length ? (
          exchanges.map((exchange, index) => (
            <ExchangeView
              key={exchange.id}
              exchange={exchange}
              organizationId={organizationId}
              onRetry={() =>
                void ask(exchange.question, exchanges.slice(0, index))
              }
            />
          ))
        ) : availability.data ? (
          <div className="assistant-empty">
            <LumaMark className="assistant-empty-mark" />
            <h3>{m.assistant_empty_title()}</h3>
            <p>{m.assistant_empty_description()}</p>
            <a
              className="assistant-guide"
              href="/docs/ask-luma"
              target="_blank"
              rel="noreferrer"
            >
              {m.assistant_empty_guide_link()}
            </a>
            <ul
              className="assistant-suggestions"
              aria-label={m.assistant_suggestions_label()}
            >
              {suggestions.map((suggestion) => (
                <li key={suggestion}>
                  <button type="button" onClick={() => void ask(suggestion)}>
                    <span>{suggestion}</span>
                    <ArrowUpRight aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>

      <form className="assistant-composer" onSubmit={submit}>
        <div
          className="assistant-input"
          data-disabled={!available || undefined}
        >
          <label htmlFor="assistant-question" className="sr-only">
            {m.assistant_composer_label()}
          </label>
          <textarea
            id="assistant-question"
            ref={input}
            rows={1}
            value={draft}
            maxLength={maxQuestion}
            disabled={!available}
            placeholder={
              exchanges.length
                ? m.assistant_composer_placeholder_follow_up()
                : m.assistant_composer_placeholder()
            }
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onComposerKey}
          />
          {pending ? (
            <Button
              type="button"
              size="icon"
              variant="outline"
              className="assistant-send"
              aria-label={m.assistant_composer_stop()}
              title={m.assistant_composer_stop_title()}
              onClick={() => abort.current?.abort()}
            >
              <Square aria-hidden="true" className="assistant-stop-icon" />
            </Button>
          ) : (
            <Button
              type="submit"
              size="icon"
              className="assistant-send"
              aria-label={m.assistant_composer_send()}
              title={m.assistant_composer_send_title()}
              disabled={!available || !draft.trim()}
            >
              <ArrowUp aria-hidden="true" />
            </Button>
          )}
        </div>
        <p className="assistant-footnote">
          {draft.length > maxQuestion - 200 ? (
            <span className="assistant-count">
              {m.assistant_composer_count({
                count: draft.length,
                max: maxQuestion,
              })}{' '}
              ·{' '}
            </span>
          ) : null}
          {m.assistant_composer_footnote()}{' '}
          <span className="assistant-shortcut">
            {rich(m.assistant_composer_shortcut, {
              keys: (
                <>
                  <Kbd>{modifier}</Kbd>
                  <Kbd>J</Kbd>
                </>
              ),
            })}
          </span>
        </p>
      </form>
    </aside>
  );
}
