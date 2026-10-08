import type {
  AssistantAnswer,
  AssistantCitation,
  AssistantRecordKind,
  AssistantStep,
  AssistantTurn,
} from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
import type { Domain } from '@luma/ui/components/primitives/domain-icon';

export type Inline =
  | { type: 'text'; text: string }
  | { type: 'strong'; text: string }
  | { type: 'code'; text: string }
  | { type: 'citation'; citation: AssistantCitation; number: number };

export type Block =
  | { type: 'paragraph'; lines: Inline[][] }
  | { type: 'list'; ordered: boolean; items: Inline[][] };

const kinds = 'order|issue|stock_position|fulfillment|return';
const inlinePattern = new RegExp(
  `(\\[\\[(?:${kinds}):[0-9a-f-]{36}\\]\\]|\\*\\*[^*\\n]+\\*\\*|\`[^\`\\n]+\`)`,
  'g',
);
const bullet = /^\s*[-*•]\s+/;
const numbered = /^\s*\d+[.)]\s+/;

/** The key a citation marker uses, as in `[[order:<id>]]`. */
export const citationKey = (citation: Pick<AssistantCitation, 'kind' | 'id'>) =>
  `[[${citation.kind}:${citation.id}]]`;

/**
 * Splits answer text into paragraphs and lists with bold, code and numbered citations. Only
 * this small Markdown subset is recognized; everything else stays plain text, so model output
 * never becomes HTML. Markers without a matching citation are dropped.
 */
export function parseAnswer(
  content: string,
  citations: readonly AssistantCitation[],
): Block[] {
  const numbers = new Map(
    citations.map((citation, index) => [citationKey(citation), index + 1]),
  );
  const byKey = new Map(
    citations.map((citation) => [citationKey(citation), citation]),
  );
  const inline = (text: string): Inline[] =>
    text.split(inlinePattern).flatMap((part): Inline[] => {
      if (!part) return [];
      if (part.startsWith('[[')) {
        const citation = byKey.get(part);

        return citation
          ? [{ type: 'citation', citation, number: numbers.get(part)! }]
          : [];
      }
      if (part.startsWith('**') && part.length > 4)
        return [{ type: 'strong', text: part.slice(2, -2) }];
      if (part.startsWith('`') && part.length > 2)
        return [{ type: 'code', text: part.slice(1, -1) }];

      return [{ type: 'text', text: part }];
    });

  const blocks: Block[] = [];
  for (const chunk of content.split(/\n\s*\n/)) {
    const lines = chunk.split('\n').filter((line) => line.trim());
    let paragraph: string[] = [];
    let list: { ordered: boolean; items: string[] } | null = null;
    const flush = () => {
      if (paragraph.length)
        blocks.push({ type: 'paragraph', lines: paragraph.map(inline) });
      if (list)
        blocks.push({
          type: 'list',
          ordered: list.ordered,
          items: list.items.map(inline),
        });
      paragraph = [];
      list = null;
    };
    for (const line of lines) {
      const marker = bullet.test(line)
        ? bullet
        : numbered.test(line)
          ? numbered
          : null;
      if (marker) {
        const ordered = marker === numbered;
        if (paragraph.length || (list && list.ordered !== ordered)) flush();
        list ??= { ordered, items: [] };
        list.items.push(line.replace(marker, ''));
      } else if (list && /^\s{2,}\S/.test(line)) {
        // An indented line continues the previous list item.
        list.items[list.items.length - 1] += ` ${line.trim()}`;
      } else {
        if (list) flush();
        paragraph.push(line.trim());
      }
    }
    flush();
  }

  return blocks;
}

export const recordDomain: Record<AssistantRecordKind, Domain> = {
  order: 'orders',
  issue: 'issues',
  stock_position: 'inventory',
  fulfillment: 'fulfillment',
  return: 'returns',
};

/** "Issue · Stuck fulfillment"; other labels already name their kind. */
export function citationTitle(citation: AssistantCitation) {
  if (citation.kind === 'issue')
    return m.assistant_citation_issue({ label: citation.label });
  if (citation.kind === 'stock_position')
    return m.assistant_citation_stock({ label: citation.label });

  return citation.label;
}

/** Shown when a step's outcome is not a plain success. */
export const stepOutcomeLabel: Record<
  AssistantStep['outcome'],
  (() => string) | null
> = {
  ok: null,
  invalid_arguments: m.assistant_step_retried,
  not_found: m.assistant_step_not_found,
  failed: m.assistant_step_failed,
  skipped: m.assistant_step_skipped,
};

/** "3 reads · 12 records" for the collapsed step list. */
export function stepsSummary(steps: readonly AssistantStep[]) {
  const reads = steps.filter((step) => step.outcome !== 'skipped').length;
  const records = steps.reduce((total, step) => total + step.records, 0);
  const failed = steps.some((step) => step.outcome === 'failed');

  return [
    m.assistant_steps_reads({ count: reads }),
    m.assistant_steps_records({ count: records }),
    failed ? m.assistant_steps_read_failed() : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** A turn in the panel: a question, and its answer or failure once known. */
export type Exchange = {
  id: string;
  question: string;
  state:
    | { status: 'pending' }
    | { status: 'answered'; answer: AssistantAnswer }
    | { status: 'failed'; message: string }
    | { status: 'stopped' };
};

const maxHistory = 20;
const maxTurnLength = 8000;

/** Earlier answered turns, oldest first and within the request limits, for a follow-up. */
export function historyFor(exchanges: readonly Exchange[]): AssistantTurn[] {
  const turns = exchanges.flatMap((exchange): AssistantTurn[] =>
    exchange.state.status === 'answered'
      ? [
          { role: 'user', content: exchange.question },
          { role: 'assistant', content: exchange.state.answer.content },
        ]
      : [],
  );

  return turns.slice(-maxHistory).map((turn) => ({
    ...turn,
    content:
      turn.content.length > maxTurnLength
        ? `${turn.content.slice(0, maxTurnLength - 1)}…`
        : turn.content,
  }));
}

const suggestionsByKind: [AssistantRecordKind, () => string][] = [
  ['order', m.assistant_suggestion_orders],
  ['issue', m.assistant_suggestion_issues],
  ['fulfillment', m.assistant_suggestion_fulfillment],
  ['stock_position', m.assistant_suggestion_stock],
  ['return', m.assistant_suggestion_returns],
];

/** Localized starter questions for the records this workspace's assistant can read. */
export function suggestionsFor(reads: readonly AssistantRecordKind[]) {
  return suggestionsByKind
    .filter(([kind]) => reads.includes(kind))
    .map(([, question]) => question())
    .slice(0, 4);
}
