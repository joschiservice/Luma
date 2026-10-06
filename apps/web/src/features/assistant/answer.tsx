import type {
  AssistantAnswer,
  AssistantCitation,
  AssistantStep,
} from '@luma/api-contract';
import { DomainIcon } from '@luma/ui/components/primitives/domain-icon';
import { WorkspaceTimezone } from '@luma/ui/components/primitives/workspace-date';
import { Link } from '@tanstack/react-router';
import {
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CircleMinus,
  CircleSlash,
} from 'lucide-react';
import { type ReactNode, useContext } from 'react';

import {
  type Block,
  citationTitle,
  type Inline,
  parseAnswer,
  recordDomain,
  stepOutcomeLabel,
  stepsSummary,
} from './presentation';

/** Links to the detail page of a cited record. */
function RecordLink({
  organizationId,
  citation,
  className,
  title,
  onNavigate,
  children,
}: {
  organizationId: string;
  citation: AssistantCitation;
  className: string;
  title?: string;
  onNavigate: () => void;
  children: ReactNode;
}) {
  const shared = { className, title, onClick: onNavigate };
  switch (citation.kind) {
    case 'order':
      return (
        <Link
          {...shared}
          to="/app/$organizationId/orders/$orderId"
          params={{ organizationId, orderId: citation.id }}
        >
          {children}
        </Link>
      );
    case 'issue':
      return (
        <Link
          {...shared}
          to="/app/$organizationId/exceptions/$exceptionId/detail"
          params={{ organizationId, exceptionId: citation.id }}
        >
          {children}
        </Link>
      );
    case 'stock_position':
      return (
        <Link
          {...shared}
          to="/app/$organizationId/inventory/$positionId"
          params={{ organizationId, positionId: citation.id }}
        >
          {children}
        </Link>
      );
    case 'fulfillment':
      return (
        <Link
          {...shared}
          to="/app/$organizationId/fulfillment/$fulfillmentId"
          params={{ organizationId, fulfillmentId: citation.id }}
        >
          {children}
        </Link>
      );
    case 'return':
      return (
        <Link
          {...shared}
          to="/app/$organizationId/returns/$returnId"
          params={{ organizationId, returnId: citation.id }}
        >
          {children}
        </Link>
      );
  }
}

/** "11:02" for today and "5 Oct" before, in the workspace timezone, with the full time as a title. */
function useReadTime() {
  const timeZone = useContext(WorkspaceTimezone);
  const day = new Intl.DateTimeFormat('en-CA', { timeZone });
  const time = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
  });
  const date = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    day: 'numeric',
    month: 'short',
  });
  const full = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    dateStyle: 'medium',
    timeStyle: 'short',
  });

  return (value: string) => {
    const at = new Date(value);

    return {
      short:
        day.format(at) === day.format(new Date())
          ? time.format(at)
          : date.format(at),
      full: `${full.format(at)} ${timeZone}`,
    };
  };
}

function sourceLine(citation: AssistantCitation) {
  return citation.sources.map((source) => source.label).join(', ');
}

function InlineContent({
  parts,
  organizationId,
  onNavigate,
}: {
  parts: Inline[];
  organizationId: string;
  onNavigate: () => void;
}) {
  return parts.map((part, index) => {
    switch (part.type) {
      case 'strong':
        return <strong key={index}>{part.text}</strong>;
      case 'code':
        return <code key={index}>{part.text}</code>;
      case 'citation':
        return (
          <RecordLink
            key={index}
            organizationId={organizationId}
            citation={part.citation}
            className="assistant-cite"
            title={citationTitle(part.citation)}
            onNavigate={onNavigate}
          >
            <span aria-hidden="true">{part.number}</span>
            <span className="sr-only">
              Source {part.number}: {citationTitle(part.citation)}
            </span>
          </RecordLink>
        );
      default:
        return part.text;
    }
  });
}

function Blocks({
  blocks,
  organizationId,
  onNavigate,
}: {
  blocks: Block[];
  organizationId: string;
  onNavigate: () => void;
}) {
  const inline = (parts: Inline[]) => (
    <InlineContent
      parts={parts}
      organizationId={organizationId}
      onNavigate={onNavigate}
    />
  );

  return blocks.map((block, index) => {
    if (block.type === 'list') {
      const List = block.ordered ? 'ol' : 'ul';

      return (
        <List key={index}>
          {block.items.map((item, itemIndex) => (
            <li key={itemIndex}>{inline(item)}</li>
          ))}
        </List>
      );
    }

    return (
      <p key={index}>
        {block.lines.map((line, lineIndex) => (
          <span key={lineIndex}>
            {lineIndex ? <br /> : null}
            {inline(line)}
          </span>
        ))}
      </p>
    );
  });
}

const stepIcons: Record<AssistantStep['outcome'], ReactNode> = {
  ok: <CircleCheck aria-hidden="true" data-tone="ok" />,
  invalid_arguments: <CircleMinus aria-hidden="true" data-tone="muted" />,
  not_found: <CircleMinus aria-hidden="true" data-tone="muted" />,
  failed: <CircleAlert aria-hidden="true" data-tone="error" />,
  skipped: <CircleSlash aria-hidden="true" data-tone="muted" />,
};

/** What Luma read to answer, collapsed to a one-line summary. */
export function AnswerSteps({ steps }: { steps: AssistantStep[] }) {
  if (!steps.length) return null;

  return (
    <details className="assistant-steps">
      <summary>
        <ChevronRight aria-hidden="true" className="assistant-steps-chevron" />
        <span>{stepsSummary(steps)}</span>
      </summary>
      <ol>
        {steps.map((step, index) => (
          <li key={index} data-outcome={step.outcome}>
            {stepIcons[step.outcome]}
            <span>
              {step.summary}
              <span className="assistant-step-meta">
                {stepOutcomeLabel[step.outcome] ??
                  (step.records === 1 ? '1 record' : `${step.records} records`)}
              </span>
            </span>
          </li>
        ))}
      </ol>
    </details>
  );
}

/**
 * Renders an answer: text with numbered citations, then each cited record with its source
 * and when Luma read it. `onNavigate` runs when a record link is followed.
 */
export function AnswerContent({
  answer,
  organizationId,
  onNavigate,
}: {
  answer: AssistantAnswer;
  organizationId: string;
  onNavigate: () => void;
}) {
  const readTime = useReadTime();
  const blocks = parseAnswer(answer.content, answer.citations);

  return (
    <>
      <div className="assistant-prose">
        <Blocks
          blocks={blocks}
          organizationId={organizationId}
          onNavigate={onNavigate}
        />
      </div>
      {answer.citations.length ? (
        <section className="assistant-sources" aria-label="Sources">
          <h3>Sources</h3>
          <ol>
            {answer.citations.map((citation, index) => {
              const read = citation.observedAt
                ? readTime(citation.observedAt)
                : null;

              return (
                <li key={`${citation.kind}:${citation.id}`}>
                  <RecordLink
                    organizationId={organizationId}
                    citation={citation}
                    className="assistant-source"
                    onNavigate={onNavigate}
                  >
                    <span className="assistant-source-number">{index + 1}</span>
                    <DomainIcon
                      domain={recordDomain[citation.kind]}
                      size="xs"
                    />
                    <span className="assistant-source-copy">
                      <strong>{citationTitle(citation)}</strong>
                      <span>
                        {[citation.detail, sourceLine(citation)]
                          .filter(Boolean)
                          .join(' · ')}
                      </span>
                    </span>
                    {read ? (
                      <time
                        className="assistant-source-time"
                        dateTime={citation.observedAt ?? undefined}
                        title={`${citation.kind === 'issue' ? 'Last activity' : 'Read from source'} ${read.full}`}
                      >
                        <span className="sr-only">
                          {citation.kind === 'issue' ? 'Updated' : 'Read'}{' '}
                        </span>
                        {read.short}
                      </time>
                    ) : null}
                  </RecordLink>
                </li>
              );
            })}
          </ol>
        </section>
      ) : null}
    </>
  );
}
